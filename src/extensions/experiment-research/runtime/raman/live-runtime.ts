import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ArtifactRef,
	ExecutionUnit,
	ProcedureSpec,
	RamanAcquisition,
	RamanEvaluationDecision,
	RamanObservationMetrics,
	RamanSearchEnvelope,
	RunState,
	RuntimeError,
} from "../../schemas/index.ts";
import { appendArtifactRecord } from "../../store/artifact-store.ts";
import { runRoot } from "../../store/layout.ts";
import { evaluateRamanGoodEnough } from "../../planner/evaluate-good-enough.ts";
import {
	failedActionResult,
	type ActionResult,
	type AutofocusRunSingleAction,
	type FrameCaptureLatestAction,
	type SpectrometerAcquireSpectrumAction,
	type StageGetPositionAction,
	type StageMoveAbsoluteAndWaitAction,
} from "./actions.ts";
import type { FrameProviderResource, SpectrometerResource, StageResource } from "./resources.ts";

export interface RamanLivePreflightResult {
	preflightReady: boolean;
	controlAvailable: boolean;
	details?: Record<string, unknown>;
}

export interface RamanStageRuntime {
	resource: StageResource;
	getPosition(action: StageGetPositionAction): Promise<ActionResult> | ActionResult;
	moveAbsoluteAndWait(action: StageMoveAbsoluteAndWaitAction): Promise<ActionResult> | ActionResult;
}

export interface RamanAutofocusRuntime {
	runSingle(action: AutofocusRunSingleAction): Promise<ActionResult> | ActionResult;
}

export interface RamanFrameRuntime {
	resource: FrameProviderResource;
	captureLatest(action: FrameCaptureLatestAction): Promise<ActionResult> | ActionResult;
}

export interface RamanSpectrometerRuntime {
	resource: SpectrometerResource;
	acquireSpectrum(action: SpectrometerAcquireSpectrumAction): Promise<ActionResult> | ActionResult;
}

export interface RamanLiveRuntime {
	preflight(): Promise<RamanLivePreflightResult> | RamanLivePreflightResult;
	stage: RamanStageRuntime;
	autofocus: RamanAutofocusRuntime;
	frame: RamanFrameRuntime;
	spectrometer: RamanSpectrometerRuntime;
}

export interface LiveRamanUnitSuccess {
	status: "completed";
	artifactRefs: ArtifactRef[];
	observationMetrics?: RamanObservationMetrics;
	evaluationDecision?: RamanEvaluationDecision;
}

export interface LiveRamanUnitPause {
	status: "paused";
	reason: string;
	artifactRefs: ArtifactRef[];
}

export interface LiveRamanUnitFailure {
	status: "failed";
	error: RuntimeError;
	artifactRefs: ArtifactRef[];
}

export type LiveRamanUnitResult = LiveRamanUnitSuccess | LiveRamanUnitPause | LiveRamanUnitFailure;

export interface LiveRamanUnitOptions {
	acquisitionOverride?: RamanAcquisition;
	evaluation?: {
		attemptIndex: number;
		recentObservations: RamanObservationMetrics[];
		envelope?: RamanSearchEnvelope;
		singlePointAcceptance?: boolean;
	};
}

interface StagePosition {
	xUm: number;
	yUm: number;
	zUm: number;
}

const liveRuntimeRegistry = new Map<string, RamanLiveRuntime>();
const DEFAULT_STAGE_MOVE_TIMEOUT_MS = 120_000;
const DEFAULT_AUTOFOCUS_TIMEOUT_MS = 150_000;

function toRuntimeError(actionResult: ActionResult, fallbackCode: string, scope: RuntimeError["scope"] = "unit"): RuntimeError {
	return {
		errorCode: actionResult.errorCode ?? fallbackCode,
		message: actionResult.summary,
		retrySafe: actionResult.retrySafe,
		needsOperator: actionResult.needsOperator,
		safeToResume: actionResult.safeToResume,
		scope,
		payload: actionResult.payload,
	};
}

function findResourceId(spec: ProcedureSpec, role: string): string {
	const resource = spec.resources.find((candidate) => candidate.role === role);
	if (!resource) {
		throw new Error(`missing resource role: ${role}`);
	}
	return resource.resourceId;
}

function ensureRange(
	value: number | undefined,
	minimum: number | undefined,
	maximum: number | undefined,
	errorCode: string,
	message: string,
): ActionResult | undefined {
	if (value === undefined) {
		return undefined;
	}
	if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
		return failedActionResult(message, {
			errorCode,
			message,
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
		});
	}
	return undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function stagePositionFromActionResult(result: ActionResult): StagePosition | undefined {
	const payload = result.payload;
	if (payload === undefined) {
		return undefined;
	}
	const position = payload.position;
	if (typeof position !== "object" || position === null || Array.isArray(position)) {
		return undefined;
	}
	const record = position as Record<string, unknown>;
	const xUm = readNumber(record, "xUm");
	const yUm = readNumber(record, "yUm");
	const zUm = readNumber(record, "zUm");
	if (xUm === undefined || yUm === undefined || zUm === undefined) {
		return undefined;
	}
	return { xUm, yUm, zUm };
}

async function resolveUnitPosition(unit: ExecutionUnit, runtime: RamanLiveRuntime, stageResourceId: string): Promise<ActionResult | StagePosition> {
	if (unit.positionRef === "current") {
		const positionResult = await runtime.stage.getPosition({
			action: "stage.get_position",
			resourceId: stageResourceId,
			timeoutMs: 10_000,
		});
		if (positionResult.status !== "success") {
			return positionResult;
		}
		const position = stagePositionFromActionResult(positionResult);
		if (!position) {
			return failedActionResult("Stage position result did not include xUm, yUm, and zUm.", {
				errorCode: "invalid_stage_position_result",
				message: "Live Raman current-position execution requires a complete stage position.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			});
		}
		return position;
	}

	if (!unit.point) {
		return failedActionResult("Single-point live execution requires point coordinates.", {
			errorCode: "missing_point_coordinates",
			message: "ExecutionUnit point coordinates are required for live Raman motion.",
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
		});
	}
	if (unit.point.zUm === undefined) {
		return failedActionResult("Single-point live execution requires a Z coordinate.", {
			errorCode: "missing_z_coordinate",
			message: "Live Raman motion requires xUm, yUm, and zUm.",
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
		});
	}
	return { xUm: unit.point.xUm, yUm: unit.point.yUm, zUm: unit.point.zUm };
}

function enforceMotionHardLimits(spec: ProcedureSpec, position: StagePosition, runtime: RamanLiveRuntime): ActionResult | undefined {
	const stageLimits = runtime.stage.resource.limits;
	const xResult =
		ensureRange(
			position.xUm,
			spec.limits.xRangeUm?.minUm ?? stageLimits.xRangeUm[0],
			spec.limits.xRangeUm?.maxUm ?? stageLimits.xRangeUm[1],
			"motion_out_of_bounds",
			`Requested X position ${position.xUm} um is outside the allowed motion range.`,
		);
	if (xResult) {
		return xResult;
	}

	const yResult =
		ensureRange(
			position.yUm,
			spec.limits.yRangeUm?.minUm ?? stageLimits.yRangeUm[0],
			spec.limits.yRangeUm?.maxUm ?? stageLimits.yRangeUm[1],
			"motion_out_of_bounds",
			`Requested Y position ${position.yUm} um is outside the allowed motion range.`,
		);
	if (yResult) {
		return yResult;
	}

	const zResult =
		ensureRange(
			position.zUm,
			spec.limits.zRangeUm?.minUm ?? stageLimits.zRangeUm[0],
			spec.limits.zRangeUm?.maxUm ?? stageLimits.zRangeUm[1],
			"motion_out_of_bounds",
			`Requested Z position ${position.zUm} um is outside the allowed motion range.`,
		);
	if (zResult) {
		return zResult;
	}

	if (
		spec.limits.minObjectiveClearanceUm !== undefined &&
		position.zUm < spec.limits.minObjectiveClearanceUm
	) {
		return failedActionResult(
			`Requested Z position ${position.zUm} um violates minObjectiveClearanceUm ${spec.limits.minObjectiveClearanceUm} um.`,
			{
				errorCode: "objective_clearance_violation",
				message: "Requested motion would move the objective below the approved clearance.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			},
		);
	}

	return undefined;
}

function enforceLaserHardLimit(
	spec: ProcedureSpec,
	acquisition: RamanAcquisition,
	spectrometer: SpectrometerResource,
): ActionResult | undefined {
	const requestedPower = acquisition.laserPowerPercent;
	const maxPower = spec.limits.maxLaserPowerPercent;
	if (maxPower !== undefined && requestedPower > maxPower) {
		return failedActionResult(
			`Requested laser power ${requestedPower}% exceeds maxLaserPowerPercent ${maxPower}%.`,
			{
				errorCode: "laser_power_limit_exceeded",
				message: "Requested laser power exceeds the approved safety ceiling.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			},
		);
	}
	const configuredPower = spectrometer.config.laserPower;
	if (configuredPower?.maxAllowedPercent !== undefined && requestedPower > configuredPower.maxAllowedPercent) {
		return failedActionResult(
			`Requested laser power ${requestedPower}% exceeds spectrometer maxAllowedPercent ${configuredPower.maxAllowedPercent}%.`,
			{
				errorCode: "laser_power_limit_exceeded",
				message: "Requested laser power exceeds the spectrometer lab configuration.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			},
		);
	}
	if (configuredPower && !configuredPower.allowedPercentValues.includes(requestedPower)) {
		return failedActionResult(
			`Requested laser power ${requestedPower}% is not one of the configured Raman laser power presets: ${configuredPower.allowedPercentValues.join(", ")}.`,
			{
				errorCode: "laser_power_preset_unavailable",
				message: "Requested laser power is not a configured spectrometer preset.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			},
		);
	}
	return undefined;
}

function persistArtifactRecord(cwd: string, runId: string, artifact: ArtifactRef): void {
	appendArtifactRecord(cwd, {
		runId,
		recordedAt: new Date().toISOString(),
		artifact,
	});
}

function persistEvaluationArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	metrics: RamanObservationMetrics,
	decision: RamanEvaluationDecision,
): ArtifactRef {
	const relativePath = `${unit.artifactScope.artifactPathPrefix.replace(/^records\//u, "")}-evaluation.json`;
	const absolutePath = join(runRoot(cwd, runId), relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(
		absolutePath,
		`${JSON.stringify({ unitId: unit.unitId, metrics, decision }, null, 2)}\n`,
		"utf-8",
	);
	return {
		artifactId: `${runId}-evaluation-${unit.index}`,
		kind: "raman-evaluation",
		path: relativePath.replace(/\\/gu, "/"),
		label: "Rule-based Raman evaluation",
		metadata: {
			decision: decision.decision,
		},
	};
}

function persistAutofocusArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	autofocusResult: ActionResult,
): ArtifactRef {
	const relativePath = `${unit.artifactScope.artifactPathPrefix.replace(/^records\//u, "")}-autofocus.json`;
	const absolutePath = join(runRoot(cwd, runId), relativePath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(
		absolutePath,
		`${JSON.stringify(
			{
				unitId: unit.unitId,
				status: autofocusResult.status,
				summary: autofocusResult.summary,
				errorCode: autofocusResult.errorCode,
				payload: autofocusResult.payload ?? {},
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return {
		artifactId: `${runId}-autofocus-${unit.index}`,
		kind: "raman-autofocus",
		path: relativePath.replace(/\\/gu, "/"),
		label: "Raman autofocus result",
		metadata: {
			status: autofocusResult.status,
			confidence: autofocusResult.payload?.confidence,
			zBestUm: autofocusResult.payload?.zBestUm,
		},
	};
}

function buildObservationMetrics(autofocusResult: ActionResult, spectrumResult: ActionResult): RamanObservationMetrics | RuntimeError {
	const autofocusPayload = autofocusResult.payload ?? {};
	const spectrumPayload = spectrumResult.payload ?? {};
	const autofocusConfidence = autofocusPayload.confidence;
	const saturated = spectrumPayload.saturated;
	const snr = spectrumPayload.snr;
	const targetPeakBaselineRatio = spectrumPayload.targetPeakBaselineRatio;

	if (
		typeof autofocusConfidence !== "number" ||
		typeof saturated !== "boolean" ||
		typeof snr !== "number" ||
		typeof targetPeakBaselineRatio !== "number"
	) {
		return {
			errorCode: "missing_evaluation_metrics",
			message: "Live Raman execution requires autofocus confidence and spectrum quality metrics for explicit evaluation.",
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
			scope: "unit",
		};
	}

	return {
		autofocusConfidence,
		saturated,
		snr,
		targetPeakBaselineRatio,
	};
}

function normalizeAutofocusResult(spec: ProcedureSpec, runtime: RamanLiveRuntime, result: ActionResult): ActionResult {
	const zBestUm = result.payload?.zBestUm;
	const stageLimits = runtime.stage.resource.limits;
	const zRange = spec.limits.zRangeUm;
	const minClearance = spec.limits.minObjectiveClearanceUm;

	if (typeof zBestUm === "number") {
		if (minClearance !== undefined && zBestUm < minClearance) {
			return failedActionResult(`Autofocus settled at ${zBestUm} um below minObjectiveClearanceUm ${minClearance} um.`, {
				errorCode: "objective_clearance_violation",
				message: "Autofocus would leave the objective below the approved clearance.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			});
		}

		const zFailure = ensureRange(
			zBestUm,
			zRange?.minUm ?? stageLimits.zRangeUm[0],
			zRange?.maxUm ?? stageLimits.zRangeUm[1],
			"motion_out_of_bounds",
			`Autofocus settled at Z=${zBestUm} um outside the allowed Z range.`,
		);
		if (zFailure) {
			return zFailure;
		}
	}

	return result;
}

function resolveAutofocusActionParams(spec: ProcedureSpec): NonNullable<AutofocusRunSingleAction["params"]> | ActionResult {
	const params = spec.domain.raman.autofocus.params;
	if (typeof params?.zStartUm !== "number" || typeof params.zEndUm !== "number") {
		return failedActionResult("Fixed-range autofocus requires zStartUm and zEndUm in ProcedureSpec domain.raman.autofocus.params.", {
			errorCode: "autofocus_invalid_params",
			message: "Live Raman autofocus no longer supports coarse/fine search parameters; provide fixed zStartUm and zEndUm.",
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
		});
	}
	return {
		...params,
		zStartUm: params.zStartUm,
		zEndUm: params.zEndUm,
	};
}

function autofocusRange(spec: ProcedureSpec): { zStartUm: number; zEndUm: number } | undefined {
	const params = spec.domain.raman.autofocus.params;
	const zStartUm = params?.zStartUm;
	const zEndUm = params?.zEndUm;
	if (typeof zStartUm !== "number" || typeof zEndUm !== "number") {
		return undefined;
	}
	return { zStartUm, zEndUm };
}

function zAnchorFromSpec(spec: ProcedureSpec): number | undefined {
	const plan = spec.plan;
	if (plan.kind === "point_list") {
		return plan.points.find((point) => typeof point.zUm === "number")?.zUm;
	}
	return undefined;
}

export async function validateRuntimeAnchorState(
	spec: ProcedureSpec,
	runtime: RamanLiveRuntime,
): Promise<{ valid: boolean; details: Record<string, unknown> }> {
	const stageResource = spec.resources.find((resource) => resource.role === "stage");
	if (!stageResource) {
		return {
			valid: false,
			details: {
				errorCode: "preflight_missing_stage_resource",
				message: "Live preflight requires a stage resource.",
			},
		};
	}

	const positionResult = await runtime.stage.getPosition({
		action: "stage.get_position",
		resourceId: stageResource.resourceId,
		timeoutMs: 10_000,
	});
	if (positionResult.status !== "success") {
		return {
			valid: false,
			details: {
				errorCode: positionResult.errorCode ?? "preflight_stage_position_failed",
				message: positionResult.summary,
				payload: positionResult.payload,
			},
		};
	}
	const position = stagePositionFromActionResult(positionResult);
	if (!position) {
		return {
			valid: false,
			details: {
				errorCode: "preflight_stage_position_invalid",
				message: "Stage position preflight did not return xUm, yUm, and zUm.",
				payload: positionResult.payload,
			},
		};
	}

	const range = autofocusRange(spec);
	const zAnchorUm = zAnchorFromSpec(spec);
	const allowedDriftUm = 5;
	const details: Record<string, unknown> = {
		stagePosition: position,
		autofocusRange: range,
		zAnchorUm,
		allowedDriftUm,
	};

	if (range) {
		const zMin = Math.min(range.zStartUm, range.zEndUm);
		const zMax = Math.max(range.zStartUm, range.zEndUm);
		if (position.zUm < zMin - allowedDriftUm || position.zUm > zMax + allowedDriftUm) {
			return {
				valid: false,
				details: {
					...details,
					errorCode: "preflight_stage_outside_autofocus_range",
					message: `Current Z=${position.zUm} um is outside autofocus range [${zMin}, ${zMax}] um with ${allowedDriftUm} um drift allowance.`,
				},
			};
		}
	}

	if (zAnchorUm !== undefined && Math.abs(position.zUm - zAnchorUm) > allowedDriftUm) {
		return {
			valid: false,
			details: {
				...details,
				errorCode: "preflight_stage_anchor_drift",
				message: `Current Z=${position.zUm} um differs from spec anchor Z=${zAnchorUm} um by more than ${allowedDriftUm} um.`,
			},
		};
	}

	return { valid: true, details };
}

export function registerRamanLiveRuntime(cwd: string, runtime: RamanLiveRuntime): void {
	liveRuntimeRegistry.set(cwd, runtime);
}

export function getRamanLiveRuntime(cwd: string): RamanLiveRuntime | undefined {
	return liveRuntimeRegistry.get(cwd);
}

export function clearRamanLiveRuntime(cwd: string): void {
	liveRuntimeRegistry.delete(cwd);
}

export async function runLiveRamanUnit(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	spec: ProcedureSpec,
	runtime: RamanLiveRuntime,
	_currentState: RunState,
	options: LiveRamanUnitOptions = {},
): Promise<LiveRamanUnitResult> {
	const artifactRefs: ArtifactRef[] = [];
	const stageResourceId = findResourceId(spec, "stage");
	const unitPosition = await resolveUnitPosition(unit, runtime, stageResourceId);
	if ("status" in unitPosition) {
		return {
			status: "failed",
			error: toRuntimeError(unitPosition, unitPosition.errorCode ?? "stage_position_read_failed"),
			artifactRefs,
		};
	}

	const preMoveFailure = enforceMotionHardLimits(spec, unitPosition, runtime);
	if (preMoveFailure) {
		return {
			status: "failed",
			error: toRuntimeError(preMoveFailure, "motion_out_of_bounds"),
			artifactRefs,
		};
	}

	const acquisition = options.acquisitionOverride ?? spec.domain.raman.acquisition;
	const frameProviderResourceId = findResourceId(spec, "frame_provider");
	const spectrometerResourceId = findResourceId(spec, "spectrometer");
	let autofocusResult: ActionResult | undefined;
	let spectrumResult: ActionResult | undefined;

	for (const action of unit.actions) {
		if (action.kind === "move_to_point") {
			if (unit.positionRef === "current") {
				continue;
			}
			const moveResult = await runtime.stage.moveAbsoluteAndWait({
				action: "stage.move_absolute_and_wait",
				resourceId: stageResourceId,
				target: {
					xUm: unitPosition.xUm,
					yUm: unitPosition.yUm,
					zUm: unitPosition.zUm,
				},
				timeoutMs: DEFAULT_STAGE_MOVE_TIMEOUT_MS,
			});
			if (moveResult.status !== "success") {
				const moveArtifacts = artifactRefs.concat(moveResult.artifacts);
				if (moveResult.status === "paused") {
					return {
						status: "paused",
						reason: moveResult.summary,
						artifactRefs: moveArtifacts,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(moveResult, "stage_move_failed"),
					artifactRefs: moveArtifacts,
				};
			}
			for (const artifact of moveResult.artifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			continue;
		}

		if (action.kind === "autofocus") {
			const autofocusParams = resolveAutofocusActionParams(spec);
			if ("status" in autofocusParams) {
				return {
					status: "failed",
					error: toRuntimeError(autofocusParams, "autofocus_invalid_params"),
					artifactRefs,
				};
			}
			autofocusResult = normalizeAutofocusResult(
				spec,
				runtime,
				await runtime.autofocus.runSingle({
					action: "autofocus.run_single",
					stageResourceId,
					frameProviderResourceId,
					roi: spec.domain.raman.autofocus.roi,
					params: autofocusParams,
					timeoutMs: DEFAULT_AUTOFOCUS_TIMEOUT_MS,
				}),
			);
			const autofocusArtifact = persistAutofocusArtifact(cwd, runId, unit, autofocusResult);
			persistArtifactRecord(cwd, runId, autofocusArtifact);
			artifactRefs.push(autofocusArtifact);
			if (autofocusResult.status !== "success") {
				const autofocusArtifacts = artifactRefs.concat(autofocusResult.artifacts);
				if (autofocusResult.status === "paused") {
					return {
						status: "paused",
						reason: autofocusResult.summary,
						artifactRefs: autofocusArtifacts,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(autofocusResult, "autofocus_failed"),
					artifactRefs: autofocusArtifacts,
				};
			}
			for (const artifact of autofocusResult.artifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			continue;
		}

		if (action.kind === "capture_frame") {
			const frameResult = await runtime.frame.captureLatest({
				action: "frame.capture_latest",
				resourceId: frameProviderResourceId,
				timeoutMs: 10_000,
				laserOff: action.laserOff ?? false,
			});
			if (frameResult.status !== "success") {
				const frameArtifacts = artifactRefs.concat(frameResult.artifacts);
				if (frameResult.status === "paused") {
					return {
						status: "paused",
						reason: frameResult.summary,
						artifactRefs: frameArtifacts,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(frameResult, "frame_capture_failed"),
					artifactRefs: frameArtifacts,
				};
			}
			for (const artifact of frameResult.artifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			continue;
		}

		if (action.kind === "acquire_spectrum") {
			const laserGuard = enforceLaserHardLimit(spec, acquisition, runtime.spectrometer.resource);
			if (laserGuard) {
				return {
					status: "failed",
					error: toRuntimeError(laserGuard, "laser_power_limit_exceeded"),
					artifactRefs,
				};
			}

			spectrumResult = await runtime.spectrometer.acquireSpectrum({
				action: "spectrometer.acquire_spectrum",
				resourceId: spectrometerResourceId,
				acquisition,
				timeoutMs: acquisition.timeoutMs ?? 60_000,
			});
			if (spectrumResult.status !== "success") {
				const spectrumArtifacts = artifactRefs.concat(spectrumResult.artifacts);
				if (spectrumResult.status === "paused") {
					return {
						status: "paused",
						reason: spectrumResult.summary,
						artifactRefs: spectrumArtifacts,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(spectrumResult, "spectrum_acquisition_failed"),
					artifactRefs: spectrumArtifacts,
				};
			}
			for (const artifact of spectrumResult.artifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
		}
	}

	if (!autofocusResult || !spectrumResult) {
		return {
			status: "failed",
			error: {
				errorCode: "single_point_action_sequence_incomplete",
				message: "Live Raman single-point execution requires autofocus and spectrum acquisition results.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
				scope: "unit",
			},
			artifactRefs,
		};
	}

	const metricsOrError = buildObservationMetrics(autofocusResult, spectrumResult);
	if ("errorCode" in metricsOrError) {
		return {
			status: "failed",
			error: metricsOrError,
			artifactRefs,
		};
	}

	if (spec.procedureId === "raman_grid_mapping") {
		return {
			status: "completed",
			artifactRefs,
			observationMetrics: metricsOrError,
		};
	}

	const evaluation = options.evaluation;
	const decision = evaluateRamanGoodEnough(
		{
			attemptIndex: evaluation?.attemptIndex ?? 0,
			current: metricsOrError,
			recentObservations: evaluation?.recentObservations ?? [],
		},
		evaluation?.envelope,
		evaluation?.singlePointAcceptance
			? {
					repeatWindowSize: 1,
					repeatPassesRequired: 1,
				}
			: undefined,
	);
	const evaluationArtifact = persistEvaluationArtifact(cwd, runId, unit, metricsOrError, decision);
	persistArtifactRecord(cwd, runId, evaluationArtifact);
	artifactRefs.push(evaluationArtifact);

	if (spec.procedureId === "raman_single_point_probe" && decision.decision !== "acceptable") {
		return {
			status: "paused",
			reason: `Single-point Raman acquisition completed but explicit evaluation returned ${decision.decision}.`,
			artifactRefs,
		};
	}

	return {
		status: "completed",
		artifactRefs,
		observationMetrics: metricsOrError,
		evaluationDecision: decision,
	};
}
