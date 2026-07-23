import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
import { isOutsideMotionRange } from "../../motion-range.ts";
import { appendArtifactRecord } from "../../store/artifact-store.ts";
import { runRoot } from "../../store/layout.ts";
import { evaluateRamanGoodEnough } from "../../planner/evaluate-good-enough.ts";
import {
	createRunRecords,
	type ArtifactDescriptor,
	type RamanSpectrumCanonicalData,
} from "../../records/run-records.ts";
import {
	failedActionResult,
	type ActionResult,
	type AutofocusRunSingleAction,
	type FrameCaptureLaserOffAction,
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

export interface RamanRuntimeCompatibilityIssue {
	code: string;
	message: string;
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
	captureLaserOff(action: FrameCaptureLaserOffAction): Promise<ActionResult> | ActionResult;
}

export interface RamanSpectrometerRuntime {
	resource: SpectrometerResource;
	acquireSpectrum(action: SpectrometerAcquireSpectrumAction): Promise<ActionResult> | ActionResult;
}

export interface RamanLiveRuntime {
	preflight(): Promise<RamanLivePreflightResult> | RamanLivePreflightResult;
	validatePlanSupport(units: ExecutionUnit[], preflight: RamanLivePreflightResult): RamanRuntimeCompatibilityIssue[];
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

export interface LiveRamanUnitAbort {
	status: "aborted";
	artifactRefs: ArtifactRef[];
}

export type LiveRamanUnitResult = LiveRamanUnitSuccess | LiveRamanUnitPause | LiveRamanUnitFailure | LiveRamanUnitAbort;

export interface LiveRamanUnitOptions {
	attempt?: {
		attemptIndex: number;
		phase: "initial" | "immediate_retry" | "final_retry";
	};
	acquisitionOverride?: RamanAcquisition;
	evaluation?: {
		attemptIndex: number;
		recentObservations: RamanObservationMetrics[];
		envelope?: RamanSearchEnvelope;
		singlePointAcceptance?: boolean;
	};
	checkpoint?: () => "abort" | "pause" | "deadline" | undefined;
}

interface StagePosition {
	xUm: number;
	yUm: number;
	zUm: number;
}

interface RamanFramePayload {
	sourcePath: string;
	canonicalDisplayPath: string;
	canonicalThumbnailPath: string;
	capturedAt: string;
	width: number;
	height: number;
	bitDepth: number;
	colorModel: string;
	laserStateVerified: string;
	canonicalizationError?: Record<string, unknown>;
}

const liveRuntimeRegistry = new Map<string, RamanLiveRuntime>();
const DEFAULT_AUTOFOCUS_TIMEOUT_MS = 150_000;
const DEFAULT_FRAME_CAPTURE_TIMEOUT_MS = 30_000;

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

function checkpointResult(
	options: LiveRamanUnitOptions,
	artifactRefs: ArtifactRef[],
): LiveRamanUnitAbort | LiveRamanUnitPause | LiveRamanUnitFailure | undefined {
	const stopReason = options.checkpoint?.();
	if (stopReason === "abort") {
		return { status: "aborted", artifactRefs };
	}
	if (stopReason === "pause") {
		return { status: "paused", reason: "operator_requested", artifactRefs };
	}
	if (stopReason === "deadline") {
		return {
			status: "failed",
			error: {
				errorCode: "run_deadline_exceeded",
				message: "Run stopped at a hardware-action checkpoint after maxRuntimeMinutes elapsed.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
				scope: "run",
			},
			artifactRefs,
		};
	}
	return undefined;
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
	if (isOutsideMotionRange(value, minimum, maximum)) {
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

function ramanFramePayload(value: unknown): RamanFramePayload {
	const payload = isRecord(value) ? value : {};
	const sourcePath = payload.sourcePath ?? payload.framePath;
	return {
		sourcePath: typeof sourcePath === "string" ? sourcePath : "",
		canonicalDisplayPath: typeof payload.canonicalDisplayPath === "string" ? payload.canonicalDisplayPath : "",
		canonicalThumbnailPath: typeof payload.canonicalThumbnailPath === "string" ? payload.canonicalThumbnailPath : "",
		capturedAt: typeof payload.capturedAt === "string" ? payload.capturedAt : "",
		width: typeof payload.width === "number" ? payload.width : 0,
		height: typeof payload.height === "number" ? payload.height : 0,
		bitDepth: typeof payload.bitDepth === "number" ? payload.bitDepth : 0,
		colorModel: typeof payload.colorModel === "string" ? payload.colorModel : "unknown",
		laserStateVerified: typeof payload.laserStateVerified === "string" ? payload.laserStateVerified : "unknown",
		...(isRecord(payload.canonicalizationError) ? { canonicalizationError: payload.canonicalizationError } : {}),
	};
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

function sourceArtifactFailure(artifacts: ArtifactRef[], actionLabel: string): RuntimeError | undefined {
	const failedArtifacts = artifacts.filter((artifact) => artifact.metadata?.publicationStatus === "failed");
	if (failedArtifacts.length === 0) {
		return undefined;
	}
	return {
		errorCode: "source_artifact_unavailable",
		message: `${actionLabel} completed, but ${failedArtifacts.length} source artifact${failedArtifacts.length === 1 ? " was" : "s were"} not preserved.`,
		retrySafe: true,
		needsOperator: false,
		safeToResume: true,
		scope: "unit",
		payload: {
			artifactIds: failedArtifacts.map((artifact) => artifact.artifactId),
			publicationErrors: failedArtifacts.map((artifact) => artifact.metadata?.publicationError),
		},
	};
}

function scopeRuntimeArtifacts(
	cwd: string,
	runId: string,
	artifacts: ArtifactRef[],
	unit: ExecutionUnit,
	actionIndex: number,
	attempt: LiveRamanUnitOptions["attempt"],
): ArtifactRef[] {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const attemptPhase = attempt?.phase ?? "initial";
	const unitId = `unit-${String(unit.index).padStart(4, "0")}`;
	const attemptId = `attempt-${String(attemptIndex).padStart(4, "0")}-${attemptPhase}`;
	const records = createRunRecords(cwd);
	return artifacts.map((artifact) => {
		const artifactId = `${artifact.artifactId}-${unit.index}-${attemptIndex}-${actionIndex}`.replace(/[^A-Za-z0-9._-]/gu, "-");
		const fileName = basename(artifact.path || `${artifact.kind}.dat`).replace(/[^A-Za-z0-9._-]/gu, "-");
		const descriptor = records.publishArtifact({
			artifactId,
			scope: {
				kind: "run",
				runId,
				unitId,
				attemptId,
				actionId: `action-${String(actionIndex).padStart(4, "0")}`,
			},
			layer: "source",
			sourceArtifactIds: [],
			createdAt: new Date().toISOString(),
			representations: [{
				role: "source",
				mediaType: mediaTypeForPath(artifact.path),
				fileName,
				sourcePath: artifact.path,
			}],
		});
		return {
			...artifact,
			artifactId,
			path: legacyArtifactPath(descriptor),
			metadata: {
				...artifact.metadata,
				pointUnitId: unit.unitId,
				attemptIndex,
				attemptPhase,
				publicationStatus: descriptor.status,
				...(descriptor.error ? { publicationError: descriptor.error } : {}),
			},
		};
	});
}

function mediaTypeForPath(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase();
	if (extension === "json") return "application/json";
	if (extension === "csv") return "text/csv";
	if (extension === "txt") return "text/plain";
	if (extension === "png") return "image/png";
	if (extension === "webp") return "image/webp";
	if (extension === "tif" || extension === "tiff") return "image/tiff";
	return "application/octet-stream";
}

function actionArtifactContext(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	actionIndex: number,
	attempt: LiveRamanUnitOptions["attempt"],
) {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const attemptId = `attempt-${String(attemptIndex).padStart(4, "0")}-${attempt?.phase ?? "initial"}`;
	const actionId = `action-${String(actionIndex).padStart(4, "0")}`;
	return {
		runId,
		unitId: unit.unitId,
		attemptId,
		actionId,
		stagingDir: join(cwd, ".pi", "experiment-research", "raman-staging", runId, unit.unitId, attemptId, actionId),
	};
}

function legacyArtifactPath(descriptor: ArtifactDescriptor): string {
	if (descriptor.scope.kind !== "run") {
		throw new Error(`legacy artifact paths only support run artifacts: ${descriptor.artifactId}`);
	}
	const representationPath = descriptor.representations[0]?.path ?? "descriptor.json";
	return `artifacts/units/${descriptor.scope.unitId}/attempts/${descriptor.scope.attemptId}/${descriptor.artifactId}/${representationPath}`;
}

function persistEvaluationArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	metrics: RamanObservationMetrics,
	decision: RamanEvaluationDecision,
	attempt: LiveRamanUnitOptions["attempt"],
	sourceArtifactIds: string[],
): ArtifactRef {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const descriptor = createRunRecords(cwd).publishArtifact({
		artifactId: `${runId}-evaluation-${unit.index}-${attemptIndex}`,
		scope: {
			kind: "run",
			runId,
			unitId: `unit-${String(unit.index).padStart(4, "0")}`,
			attemptId: `attempt-${String(attemptIndex).padStart(4, "0")}-${attempt?.phase ?? "initial"}`,
			actionId: "action-evaluation",
		},
		layer: "canonical",
		profile: "raman-evaluation",
		sourceArtifactIds,
		createdAt: new Date().toISOString(),
		canonicalData: {
			schemaVersion: 1,
			ruleSet: { id: "raman-good-enough", version: "1" },
			inputs: { artifactIds: sourceArtifactIds, metrics },
			thresholds: Object.fromEntries([
				...decision.thresholdChecks.map((check) => [check.name, check.threshold]),
				["repeatWindowSize", decision.consistencyCheck.windowSize],
				["repeatPassesRequired", decision.consistencyCheck.passesRequired],
			]),
			rules: [...decision.thresholdChecks, ...decision.booleanChecks, decision.consistencyCheck],
			decision: decision.decision,
			reasons: decision.reasons,
			unitId: unit.unitId,
		},
	});
	return {
		artifactId: descriptor.artifactId,
		kind: "raman-evaluation",
		path: legacyArtifactPath(descriptor),
		label: "Rule-based Raman evaluation",
		metadata: {
			decision: decision.decision,
			publicationStatus: descriptor.status,
			...(descriptor.error ? { publicationError: descriptor.error } : {}),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberArray(value: unknown): number[] {
	return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : [];
}

function spectrumCanonicalData(
	spectrumResult: ActionResult,
	acquisition: RamanAcquisition,
	metrics: Record<string, unknown>,
): RamanSpectrumCanonicalData {
	const canonical = isRecord(spectrumResult.payload?.canonicalSpectrum) ? spectrumResult.payload.canonicalSpectrum : {};
	const xAxis = isRecord(canonical.xAxis) ? canonical.xAxis : {};
	const yAxis = isRecord(canonical.yAxis) ? canonical.yAxis : {};
	return {
		schemaVersion: 1,
		xAxis: {
			kind: typeof xAxis.kind === "string" ? xAxis.kind : "unknown",
			unit: typeof xAxis.unit === "string" ? xAxis.unit : "unknown",
			values: numberArray(xAxis.values),
		},
		yAxis: {
			kind: typeof yAxis.kind === "string" ? yAxis.kind : "intensity",
			unit: typeof yAxis.unit === "string" ? yAxis.unit : "unknown",
			values: numberArray(yAxis.values),
		},
		acquisition,
		metrics,
	};
}

function persistSpectrumArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	spectrumResult: ActionResult,
	acquisition: RamanAcquisition,
	metrics: Record<string, unknown>,
	attempt: LiveRamanUnitOptions["attempt"],
	sourceArtifactIds: string[],
): ArtifactRef {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const descriptor = createRunRecords(cwd).publishArtifact({
		artifactId: `${runId}-spectrum-${unit.index}-${attemptIndex}`,
		scope: {
			kind: "run",
			runId,
			unitId: `unit-${String(unit.index).padStart(4, "0")}`,
			attemptId: `attempt-${String(attemptIndex).padStart(4, "0")}-${attempt?.phase ?? "initial"}`,
			actionId: "action-spectrum",
		},
		layer: "canonical",
		profile: "raman-spectrum",
		sourceArtifactIds,
		createdAt: new Date().toISOString(),
		canonicalData: spectrumCanonicalData(spectrumResult, acquisition, metrics),
	});
	return {
		artifactId: descriptor.artifactId,
		kind: "raman-spectrum",
		path: legacyArtifactPath(descriptor),
		label: "Canonical Raman spectrum",
		metadata: {
			publicationStatus: descriptor.status,
			...(descriptor.error ? { publicationError: descriptor.error } : {}),
		},
	};
}

function persistAnalysisDiagnosticArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	diagnostic: RuntimeError,
	attempt: LiveRamanUnitOptions["attempt"],
	sourceArtifactIds: string[],
): ArtifactRef {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const descriptor = createRunRecords(cwd).publishArtifact({
		artifactId: `${runId}-analysis-diagnostic-${unit.index}-${attemptIndex}`,
		scope: {
			kind: "run",
			runId,
			unitId: `unit-${String(unit.index).padStart(4, "0")}`,
			attemptId: `attempt-${String(attemptIndex).padStart(4, "0")}-${attempt?.phase ?? "initial"}`,
			actionId: "action-analysis-diagnostic",
		},
		layer: "diagnostic",
		sourceArtifactIds,
		createdAt: new Date().toISOString(),
		descriptorData: { errorCode: diagnostic.errorCode, message: diagnostic.message },
		representations: [{
			role: "diagnostic",
			mediaType: "application/json",
			fileName: "analysis-diagnostic.json",
			content: `${JSON.stringify(diagnostic, null, 2)}\n`,
		}],
	});
	return {
		artifactId: descriptor.artifactId,
		kind: "raman-analysis-diagnostic",
		path: legacyArtifactPath(descriptor),
		label: "Raman analysis diagnostic",
		metadata: {
			errorCode: diagnostic.errorCode,
			publicationStatus: descriptor.status,
			...(descriptor.error ? { publicationError: descriptor.error } : {}),
		},
	};
}

function persistFrameArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	frame: RamanFramePayload,
	attempt: LiveRamanUnitOptions["attempt"],
	sourceArtifactIds: string[],
	artifactName = "frame",
	actionId = "action-frame",
	label = "Canonical Raman frame",
): ArtifactRef {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const descriptor = createRunRecords(cwd).publishArtifact({
		artifactId: `${runId}-${artifactName}-${unit.index}-${attemptIndex}`,
		scope: {
			kind: "run",
			runId,
			unitId: `unit-${String(unit.index).padStart(4, "0")}`,
			attemptId: `attempt-${String(attemptIndex).padStart(4, "0")}-${attempt?.phase ?? "initial"}`,
			actionId,
		},
		layer: "canonical",
		profile: "raman-frame",
		sourceArtifactIds,
		createdAt: new Date().toISOString(),
		descriptorData: {
			width: frame.width,
			height: frame.height,
			sourceBitDepth: frame.bitDepth,
			colorModel: frame.colorModel,
			capturedAt: frame.capturedAt,
			sourceArtifactIds,
			laserState: frame.laserStateVerified,
			...(frame.canonicalizationError ? { canonicalizationError: frame.canonicalizationError } : {}),
		},
		representations: [
			{
				role: "display",
				mediaType: "image/png",
				fileName: "frame.png",
				sourcePath: frame.canonicalDisplayPath,
			},
			{
				role: "thumbnail",
				mediaType: "image/webp",
				fileName: "thumbnail.webp",
				sourcePath: frame.canonicalThumbnailPath,
			},
		],
	});
	return {
		artifactId: descriptor.artifactId,
		kind: "raman-frame",
		path: legacyArtifactPath(descriptor),
		label,
		metadata: {
			publicationStatus: descriptor.status,
			laserState: frame.laserStateVerified,
			...(frame.canonicalizationError ? { canonicalizationError: frame.canonicalizationError } : {}),
			...(descriptor.error ? { publicationError: descriptor.error } : {}),
		},
	};
}

function persistAutofocusArtifact(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	autofocusResult: ActionResult,
	attempt: LiveRamanUnitOptions["attempt"],
	sourceArtifactIds: string[],
	frameArtifactIds: { preFocus: string; acceptedFocus: string },
): ArtifactRef {
	const attemptIndex = attempt?.attemptIndex ?? 0;
	const payload = autofocusResult.payload ?? {};
	const diagnostics = isRecord(payload.confidenceDiagnostics) ? payload.confidenceDiagnostics : {};
	const descriptor = createRunRecords(cwd).publishArtifact({
		artifactId: `${runId}-autofocus-${unit.index}-${attemptIndex}`,
		scope: {
			kind: "run",
			runId,
			unitId: `unit-${String(unit.index).padStart(4, "0")}`,
			attemptId: `attempt-${String(attemptIndex).padStart(4, "0")}-${attempt?.phase ?? "initial"}`,
			actionId: "action-autofocus",
		},
		layer: "canonical",
		profile: "raman-autofocus",
		sourceArtifactIds,
		createdAt: new Date().toISOString(),
		canonicalData: {
			schemaVersion: 1,
			unitId: unit.unitId,
			algorithmVersion: "fixed-range-autofocus-v1",
			scanPoints: Array.isArray(autofocusResult.payload?.scanPoints) ? autofocusResult.payload.scanPoints : [],
			peakEstimate: {
				zUm: readNumber(diagnostics, "peakEstimateZUm") ?? payload.zBestUm,
				score: readNumber(diagnostics, "sampledBestScore") ?? payload.finalScore,
				source: typeof diagnostics.peakEstimateSource === "string" ? diagnostics.peakEstimateSource : "unknown",
			},
			selectedFocus: {
				zUm: readNumber(diagnostics, "selectedZUm") ?? payload.zBestUm,
				score: readNumber(diagnostics, "selectedScore") ?? payload.finalScore,
				selectionSource: typeof diagnostics.selectedSource === "string" ? diagnostics.selectedSource : "unknown",
			},
			finalVerification: {
				status: autofocusResult.status,
				confidence: payload.confidence,
				score: payload.finalScore,
				finalErrorUm: diagnostics.finalErrorUm,
			},
			parameters: isRecord(payload.params) ? payload.params : {},
			frameArtifactIds: {
				preFocus: frameArtifactIds.preFocus,
				acceptedFocus: frameArtifactIds.acceptedFocus,
			},
			diagnostics,
		},
	});
	return {
		artifactId: descriptor.artifactId,
		kind: "raman-autofocus",
		path: legacyArtifactPath(descriptor),
		label: "Raman autofocus result",
		metadata: {
			status: autofocusResult.status,
			confidence: autofocusResult.payload?.confidence,
			zBestUm: autofocusResult.payload?.zBestUm,
			publicationStatus: descriptor.status,
			...(descriptor.error ? { publicationError: descriptor.error } : {}),
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
	if (plan.kind === "grid_scan") {
		return plan.grid.origin.zUm;
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
	const positionCheckpoint = checkpointResult(options, artifactRefs);
	if (positionCheckpoint) {
		return positionCheckpoint;
	}
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

	for (const [actionIndex, action] of unit.actions.entries()) {
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
				timeoutMs: 15_000,
				artifactContext: actionArtifactContext(cwd, runId, unit, actionIndex, options.attempt),
			});
			const moveResultArtifacts = scopeRuntimeArtifacts(cwd, runId, moveResult.artifacts, unit, actionIndex, options.attempt);
			for (const artifact of moveResultArtifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			const moveCheckpoint = checkpointResult(options, artifactRefs);
			if (moveCheckpoint) {
				return moveCheckpoint;
			}
			if (moveResult.status !== "success") {
				if (moveResult.status === "paused") {
					return {
						status: "paused",
						reason: moveResult.summary,
						artifactRefs,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(moveResult, "stage_move_failed"),
					artifactRefs,
				};
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
					artifactContext: actionArtifactContext(cwd, runId, unit, actionIndex, options.attempt),
				}),
			);
			const autofocusResultArtifacts = scopeRuntimeArtifacts(cwd, runId, autofocusResult.artifacts, unit, actionIndex, options.attempt);
			for (const artifact of autofocusResultArtifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			const autofocusCheckpoint = checkpointResult(options, artifactRefs);
			if (autofocusCheckpoint) {
				return autofocusCheckpoint;
			}
			if (autofocusResult.status !== "success") {
				if (autofocusResult.status === "paused") {
					return {
						status: "paused",
						reason: autofocusResult.summary,
						artifactRefs,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(autofocusResult, "autofocus_failed"),
					artifactRefs,
				};
			}
			const autofocusSourceFailure = sourceArtifactFailure(autofocusResultArtifacts, "Autofocus");
			if (autofocusSourceFailure) {
				return { status: "failed", error: autofocusSourceFailure, artifactRefs };
			}
			const autofocusFrames = isRecord(autofocusResult.payload?.autofocusFrames)
				? autofocusResult.payload.autofocusFrames
				: undefined;
			const preFocusFrame = ramanFramePayload(autofocusFrames?.preFocus);
			const acceptedFocusFrame = ramanFramePayload(autofocusFrames?.acceptedFocus);
			const preFocusSource = autofocusResultArtifacts.find((artifact) => artifact.kind === "autofocus-pre-focus-frame");
			const acceptedFocusSource = autofocusResultArtifacts.find((artifact) => artifact.kind === "autofocus-accepted-focus-frame");
			if (!preFocusSource || !acceptedFocusSource) {
				return {
					status: "failed",
					error: {
						errorCode: "source_artifact_unavailable",
						message: "Autofocus did not preserve source artifacts for both representative frames.",
						retrySafe: true,
						needsOperator: false,
						safeToResume: true,
						scope: "unit",
					},
					artifactRefs,
				};
			}
			const preFocusArtifact = persistFrameArtifact(
				cwd,
				runId,
				unit,
				preFocusFrame,
				options.attempt,
				[preFocusSource.artifactId],
				"autofocus-pre-focus-frame",
				`action-${String(actionIndex).padStart(4, "0")}-pre-focus`,
				"Autofocus pre-focus canonical frame",
			);
			const acceptedFocusArtifact = persistFrameArtifact(
				cwd,
				runId,
				unit,
				acceptedFocusFrame,
				options.attempt,
				[acceptedFocusSource.artifactId],
				"autofocus-accepted-focus-frame",
				`action-${String(actionIndex).padStart(4, "0")}-accepted-focus`,
				"Autofocus accepted-focus canonical frame",
			);
			const autofocusArtifact = persistAutofocusArtifact(
				cwd,
				runId,
				unit,
				autofocusResult,
				options.attempt,
				autofocusResultArtifacts.map((artifact) => artifact.artifactId),
				{ preFocus: preFocusArtifact.artifactId, acceptedFocus: acceptedFocusArtifact.artifactId },
			);
			for (const artifact of [preFocusArtifact, acceptedFocusArtifact, autofocusArtifact]) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			continue;
		}

		if (action.kind === "capture_frame") {
			const artifactContext = actionArtifactContext(cwd, runId, unit, actionIndex, options.attempt);
			const frameResult = action.laserState === "off"
				? await runtime.frame.captureLaserOff({
						action: "frame.capture_laser_off",
						resourceId: frameProviderResourceId,
						timeoutMs: DEFAULT_FRAME_CAPTURE_TIMEOUT_MS,
						artifactContext,
					})
				: await runtime.frame.captureLatest({
						action: "frame.capture_latest",
						resourceId: frameProviderResourceId,
						timeoutMs: DEFAULT_FRAME_CAPTURE_TIMEOUT_MS,
						artifactContext,
					});
			const frameResultArtifacts = scopeRuntimeArtifacts(cwd, runId, frameResult.artifacts, unit, actionIndex, options.attempt);
			for (const artifact of frameResultArtifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			const frameCheckpoint = checkpointResult(options, artifactRefs);
			if (frameCheckpoint) {
				return frameCheckpoint;
			}
			if (frameResult.status !== "success") {
				if (frameResult.status === "paused") {
					return {
						status: "paused",
						reason: frameResult.summary,
						artifactRefs,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(frameResult, "frame_capture_failed"),
					artifactRefs,
				};
			}
			const frameSourceFailure = sourceArtifactFailure(frameResultArtifacts, "Frame capture");
			if (frameSourceFailure) {
				return { status: "failed", error: frameSourceFailure, artifactRefs };
			}
			const canonicalFrameArtifact = persistFrameArtifact(
				cwd,
				runId,
				unit,
				ramanFramePayload(frameResult.payload),
				options.attempt,
				frameResultArtifacts.map((artifact) => artifact.artifactId),
				`frame-${action.role ?? "observation"}-${String(actionIndex).padStart(4, "0")}`,
				artifactContext.actionId,
				`${action.role ?? "observation"} canonical Raman frame`,
			);
			persistArtifactRecord(cwd, runId, canonicalFrameArtifact);
			artifactRefs.push(canonicalFrameArtifact);
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
				artifactContext: actionArtifactContext(cwd, runId, unit, actionIndex, options.attempt),
			});
			const spectrumResultArtifacts = scopeRuntimeArtifacts(cwd, runId, spectrumResult.artifacts, unit, actionIndex, options.attempt);
			for (const artifact of spectrumResultArtifacts) {
				persistArtifactRecord(cwd, runId, artifact);
				artifactRefs.push(artifact);
			}
			const spectrumCheckpoint = checkpointResult(options, artifactRefs);
			if (spectrumCheckpoint) {
				return spectrumCheckpoint;
			}
			if (spectrumResult.status !== "success") {
				if (spectrumResult.status === "paused") {
					return {
						status: "paused",
						reason: spectrumResult.summary,
						artifactRefs,
					};
				}
				return {
					status: "failed",
					error: toRuntimeError(spectrumResult, "spectrum_acquisition_failed"),
					artifactRefs,
				};
			}
			const spectrumSourceFailure = sourceArtifactFailure(spectrumResultArtifacts, "Spectrum acquisition");
			if (spectrumSourceFailure) {
				return { status: "failed", error: spectrumSourceFailure, artifactRefs };
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
	const sourceSpectrumArtifacts = artifactRefs.filter((artifact) => artifact.kind === "spectrum");
	const metrics = "errorCode" in metricsOrError ? {} : metricsOrError;
	const canonicalSpectrumArtifact = persistSpectrumArtifact(
		cwd,
		runId,
		unit,
		spectrumResult,
		acquisition,
		metrics,
		options.attempt,
		sourceSpectrumArtifacts.map((artifact) => artifact.artifactId),
	);
	persistArtifactRecord(cwd, runId, canonicalSpectrumArtifact);
	artifactRefs.push(canonicalSpectrumArtifact);
	if ("errorCode" in metricsOrError) {
		const diagnosticArtifact = persistAnalysisDiagnosticArtifact(
			cwd,
			runId,
			unit,
			metricsOrError,
			options.attempt,
			sourceSpectrumArtifacts.map((artifact) => artifact.artifactId),
		);
		persistArtifactRecord(cwd, runId, diagnosticArtifact);
		artifactRefs.push(diagnosticArtifact);
		return { status: "completed", artifactRefs };
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
	const evaluationArtifact = persistEvaluationArtifact(
		cwd,
		runId,
		unit,
		metricsOrError,
		decision,
		options.attempt,
		artifactRefs.map((artifact) => artifact.artifactId),
	);
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
