import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getRamanLiveRuntime, type ActionResult, type RamanLiveRuntime } from "../runtime/raman/index.ts";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

const StageAxisSchema = Type.Union([
	Type.Literal("x"),
	Type.Literal("y"),
	Type.Literal("z"),
]);

const StageRelativeMoveParamsSchema = Type.Object(
	{
		axis: StageAxisSchema,
		deltaUm: Type.Number(),
		confirmed: Type.Optional(Type.Boolean()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		minObjectiveClearanceUm: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const SmokeSpectrumParamsSchema = Type.Object(
	{
		confirmed: Type.Optional(Type.Boolean()),
		integrationTimeMs: Type.Optional(Type.Integer({ minimum: 1 })),
		laserPowerPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
		accumulations: Type.Optional(Type.Integer({ minimum: 1 })),
		saveFormat: Type.Optional(Type.Union([Type.Literal("txt"), Type.Literal("csv")])),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const AutofocusParamsSchema = Type.Object(
	{
		confirmed: Type.Optional(Type.Boolean()),
		roi: Type.Optional(
			Type.Object(
				{
					x: Type.Integer({ minimum: 0 }),
					y: Type.Integer({ minimum: 0 }),
					width: Type.Integer({ minimum: 1 }),
					height: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		),
		zStartUm: Type.Number(),
		zEndUm: Type.Number(),
		pointCount: Type.Optional(Type.Integer({ minimum: 3 })),
		stageTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		frameTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		settleMs: Type.Optional(Type.Integer({ minimum: 0 })),
		framesPerZ: Type.Optional(Type.Integer({ minimum: 1 })),
		warmupFramesPerZ: Type.Optional(Type.Integer({ minimum: 0 })),
		targetToleranceUm: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		finalToleranceUm: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		finalApproachOffsetUm: Type.Optional(Type.Number({ minimum: 0 })),
		interpolatePeak: Type.Optional(Type.Boolean()),
		finalVerificationFramesPerZ: Type.Optional(Type.Integer({ minimum: 1 })),
		metricName: Type.Optional(Type.String({ minLength: 1 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		minObjectiveClearanceUm: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

type StageRelativeMoveParams = Static<typeof StageRelativeMoveParamsSchema>;
type SmokeSpectrumParams = Static<typeof SmokeSpectrumParamsSchema>;
type OperatorAutofocusParams = Static<typeof AutofocusParamsSchema>;
type StageAxis = Static<typeof StageAxisSchema>;

const DEFAULT_SMOKE_SPECTRUM_INTEGRATION_TIME_MS = 1000;
const DEFAULT_SMOKE_SPECTRUM_LASER_POWER_PERCENT = 0.1;
const DEFAULT_SMOKE_SPECTRUM_ACCUMULATIONS = 1;
const DEFAULT_SMOKE_SPECTRUM_TIMEOUT_MS = 10_000;
const MAX_SMOKE_SPECTRUM_LASER_POWER_PERCENT = 0.1;
const DEFAULT_AUTOFOCUS_TIMEOUT_MS = 150_000;
const DEFAULT_AUTOFOCUS_MIN_OBJECTIVE_CLEARANCE_UM = 200;
const DEFAULT_AUTOFOCUS_ROI = { x: 100, y: 100, width: 64, height: 64 };

interface OperatorToolDetails {
	status: "success" | "warning" | "error";
	summary: string;
	errorCode?: string;
	retrySafe?: boolean;
	needsOperator?: boolean;
	stateAfter: Record<string, unknown>;
}

interface StagePosition {
	xUm: number;
	yUm: number;
	zUm: number;
}

function success(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "success",
			summary,
			stateAfter,
		},
	};
}

function warning(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "warning",
			summary,
			needsOperator: true,
			stateAfter,
		},
	};
}

function error(
	summary: string,
	errorCode: string,
	stateAfter: Record<string, unknown> = {},
	retrySafe = true,
): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "error",
			summary,
			errorCode,
			retrySafe,
			needsOperator: true,
			stateAfter,
		},
	};
}

function runtimeUnavailableState(): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return error("No live Raman runtime is registered for this workspace.", "live_runtime_unavailable", {
		realRuntimeRegistered: false,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function positionFromActionResult(result: ActionResult): StagePosition | undefined {
	const payload = result.payload;
	if (!isRecord(payload)) {
		return undefined;
	}
	const position = payload.position;
	if (!isRecord(position)) {
		return undefined;
	}
	const xUm = readNumber(position, "xUm");
	const yUm = readNumber(position, "yUm");
	const zUm = readNumber(position, "zUm");
	if (xUm === undefined || yUm === undefined || zUm === undefined) {
		return undefined;
	}
	return { xUm, yUm, zUm };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function formatStagePosition(position: StagePosition): string {
	return `X=${position.xUm} um, Y=${position.yUm} um, Z=${position.zUm} um`;
}

async function readStagePosition(runtime: RamanLiveRuntime, timeoutMs: number): Promise<ActionResult> {
	return runtime.stage.getPosition({
		action: "stage.get_position",
		resourceId: runtime.stage.resource.resourceId,
		timeoutMs,
	});
}

function targetFromDelta(position: StagePosition, axis: StageAxis, deltaUm: number): StagePosition {
	return {
		xUm: axis === "x" ? position.xUm + deltaUm : position.xUm,
		yUm: axis === "y" ? position.yUm + deltaUm : position.yUm,
		zUm: axis === "z" ? position.zUm + deltaUm : position.zUm,
	};
}

function axisLimitFor(runtime: RamanLiveRuntime, axis: StageAxis): [number, number] {
	switch (axis) {
		case "x":
			return runtime.stage.resource.limits.xRangeUm;
		case "y":
			return runtime.stage.resource.limits.yRangeUm;
		case "z":
			return runtime.stage.resource.limits.zRangeUm;
	}
}

function positionValue(position: StagePosition, axis: StageAxis): number {
	switch (axis) {
		case "x":
			return position.xUm;
		case "y":
			return position.yUm;
		case "z":
			return position.zUm;
	}
}

function checkMoveLimits(
	runtime: RamanLiveRuntime,
	target: StagePosition,
	axis: StageAxis,
	minObjectiveClearanceUm: number | undefined,
): { ok: true } | { ok: false; code: string; message: string; state: Record<string, unknown> } {
	const [minimum, maximum] = axisLimitFor(runtime, axis);
	const requested = positionValue(target, axis);
	if (requested < minimum || requested > maximum) {
		return {
			ok: false,
			code: "motion_out_of_bounds",
			message: `Requested ${axis.toUpperCase()} position ${requested} um is outside the stage resource limits.`,
			state: {
				axis,
				target,
				limits: { minUm: minimum, maxUm: maximum },
			},
		};
	}
	if (minObjectiveClearanceUm !== undefined && target.zUm < minObjectiveClearanceUm) {
		return {
			ok: false,
			code: "objective_clearance_violation",
			message: `Requested Z position ${target.zUm} um violates minObjectiveClearanceUm ${minObjectiveClearanceUm} um.`,
			state: {
				axis,
				target,
				minObjectiveClearanceUm,
			},
		};
	}
	return { ok: true };
}

export const ramanGetHardwareStatusTool = {
	name: "raman_get_hardware_status",
	label: "Raman Hardware Status",
	description: "Read live Raman runtime readiness and hardware status without starting a run.",
	promptSnippet: "Check current Raman hardware readiness through the registered live runtime",
	promptGuidelines: [
		"Use this for operator status questions such as whether the Raman hardware is connected.",
		"Do not construct a ProcedureSpec just to answer read-only hardware status questions.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const preflight = await runtime.preflight();
		const positionResult = await readStagePosition(runtime, 10_000);
		const position = positionResult.status === "success" ? positionFromActionResult(positionResult) : undefined;
		const stateAfter: Record<string, unknown> = {
			realRuntimeRegistered: true,
			preflightReady: preflight.preflightReady,
			controlAvailable: preflight.controlAvailable,
			livePreflightDetails: preflight.details ?? {},
			stageResourceId: runtime.stage.resource.resourceId,
			frameProviderResourceId: runtime.frame.resource.resourceId,
			spectrometerResourceId: runtime.spectrometer.resource.resourceId,
			stagePosition: position,
			stagePositionReadStatus: positionResult.status,
			stagePositionSummary: positionResult.summary,
		};

		if (positionResult.status !== "success") {
			return warning("Raman runtime is registered, but stage position could not be read.", stateAfter);
		}
		if (!preflight.preflightReady || !preflight.controlAvailable) {
			return warning("Raman runtime is registered but not ready for live controlled execution.", stateAfter);
		}
		if (!position) {
			return warning("Raman runtime returned an incomplete stage position.", stateAfter);
		}
		return success(`Raman hardware status is ready. Stage position: ${formatStagePosition(position)}.`, stateAfter);
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, OperatorToolDetails>;

export const ramanGetStagePositionTool = {
	name: "raman_get_stage_position",
	label: "Raman Stage Position",
	description: "Read the current Raman stage position through the registered live runtime.",
	promptSnippet: "Read current Raman stage X/Y/Z position",
	promptGuidelines: [
		"Use this for read-only position checks.",
		"Do not use legacy bridges or a ProcedureSpec for position reads when this tool is available.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const positionResult = await readStagePosition(runtime, 10_000);
		if (positionResult.status !== "success") {
			return error(positionResult.summary, positionResult.errorCode ?? "stage_position_read_failed", {
				stageResourceId: runtime.stage.resource.resourceId,
				actionStatus: positionResult.status,
				payload: positionResult.payload ?? {},
			}, positionResult.retrySafe);
		}

		const position = positionFromActionResult(positionResult);
		if (!position) {
			return error("Stage position result did not include xUm, yUm, and zUm.", "invalid_stage_position_result", {
				stageResourceId: runtime.stage.resource.resourceId,
				payload: positionResult.payload ?? {},
			}, false);
		}

		return success(`Stage position read: ${formatStagePosition(position)}.`, {
			stageResourceId: runtime.stage.resource.resourceId,
			position,
		});
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, OperatorToolDetails>;

export const ramanCaptureFrameTool = {
	name: "raman_capture_frame",
	label: "Raman Capture Frame",
	description: "Capture the latest microscope/frame-provider image through the registered live Raman runtime.",
	promptSnippet: "Capture the current microscope/frame-provider image as a frame artifact",
	promptGuidelines: [
		"Use this for operator requests to view, capture, or record the current microscope/sample image.",
		"Do not construct a Raman acquisition ProcedureSpec just to capture a frame.",
		"Return the frame artifact/path from the tool result when capture succeeds.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const frameResult = await runtime.frame.captureLatest({
			action: "frame.capture_latest",
			resourceId: runtime.frame.resource.resourceId,
			timeoutMs: 10_000,
		});
		const payload = isRecord(frameResult.payload) ? frameResult.payload : {};
		const framePath = readString(payload, "framePath");
		const stateAfter: Record<string, unknown> = {
			frameProviderResourceId: runtime.frame.resource.resourceId,
			actionStatus: frameResult.status,
			payload,
			artifactRefs: frameResult.artifacts,
		};

		if (frameResult.status !== "success") {
			return error(frameResult.summary, frameResult.errorCode ?? "frame_capture_failed", stateAfter, frameResult.retrySafe);
		}

		const summary = framePath ? `Frame captured: ${framePath}.` : "Frame captured.";
		return success(summary, stateAfter);
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, OperatorToolDetails>;

export const ramanCaptureLaserOffFrameTool = {
	name: "raman_capture_laser_off_frame",
	label: "Raman Capture Laser-Off Frame",
	description: "Ask the LabSpec worker to disable laser output, then capture the current microscope/frame-provider image.",
	promptSnippet: "Capture a microscope/sample image after requesting laser-off state through the LabSpec worker",
	promptGuidelines: [
		"Use this when the operator explicitly asks for a no-laser or laser-off sample image.",
		"Do not use this for Raman spectrum acquisition; it only captures a frame.",
		"Report whether the runtime requested laser off and return the frame artifact/path.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const frameResult = await runtime.frame.captureLaserOff({
			action: "frame.capture_laser_off",
			resourceId: runtime.frame.resource.resourceId,
			timeoutMs: 10_000,
		});
		const payload = isRecord(frameResult.payload) ? frameResult.payload : {};
		const framePath = readString(payload, "framePath");
		const stateAfter: Record<string, unknown> = {
			frameProviderResourceId: runtime.frame.resource.resourceId,
			actionStatus: frameResult.status,
			laserStateRequested: readString(payload, "laserStateRequested") ?? "off",
			payload,
			artifactRefs: frameResult.artifacts,
		};

		if (frameResult.status !== "success") {
			return error(frameResult.summary, frameResult.errorCode ?? "frame_capture_laser_off_failed", stateAfter, frameResult.retrySafe);
		}

		const summary = framePath ? `Laser-off frame captured: ${framePath}.` : "Laser-off frame captured.";
		return success(summary, stateAfter);
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, OperatorToolDetails>;

export const ramanAcquireSmokeSpectrumTool = {
	name: "raman_acquire_smoke_spectrum",
	label: "Raman Smoke Spectrum",
	description: "Acquire one minimal operator-confirmed Raman smoke spectrum through the registered live runtime.",
	promptSnippet: "Acquire one low-power smoke spectrum for hardware/debug observation after explicit operator confirmation",
	promptGuidelines: [
		"Use this only for operator debug requests such as checking whether spectrum acquisition works at the current point.",
		"Call first without confirmed=true to present the acquisition settings and laser exposure warning.",
		"Call with confirmed=true only after explicit operator confirmation.",
		"Use bounded ProcedureSpec runs for real experimental acquisition, parameter search, or mapping.",
	],
	parameters: SmokeSpectrumParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: SmokeSpectrumParams, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const acquisition = {
			integrationTimeMs: params.integrationTimeMs ?? DEFAULT_SMOKE_SPECTRUM_INTEGRATION_TIME_MS,
			laserPowerPercent: params.laserPowerPercent ?? DEFAULT_SMOKE_SPECTRUM_LASER_POWER_PERCENT,
			accumulations: params.accumulations ?? DEFAULT_SMOKE_SPECTRUM_ACCUMULATIONS,
			saveFormat: params.saveFormat ?? "txt",
		};
		const timeoutMs = params.timeoutMs ?? DEFAULT_SMOKE_SPECTRUM_TIMEOUT_MS;
		const proposalState: Record<string, unknown> = {
			spectrometerResourceId: runtime.spectrometer.resource.resourceId,
			acquisition,
			timeoutMs,
			maxLaserPowerPercent: MAX_SMOKE_SPECTRUM_LASER_POWER_PERCENT,
			requiresConfirmation: true,
			confirmed: params.confirmed === true,
		};

		if (acquisition.laserPowerPercent > MAX_SMOKE_SPECTRUM_LASER_POWER_PERCENT) {
			return error(
				`Smoke spectrum laser power ${acquisition.laserPowerPercent}% exceeds operator debug limit ${MAX_SMOKE_SPECTRUM_LASER_POWER_PERCENT}%.`,
				"laser_power_limit_exceeded",
				proposalState,
				false,
			);
		}

		if (params.confirmed !== true) {
			return warning(
				`Smoke spectrum requires explicit confirmation before laser exposure. Settings: ${acquisition.integrationTimeMs} ms, ${acquisition.laserPowerPercent}%, ${acquisition.accumulations} accumulation(s).`,
				proposalState,
			);
		}

		const spectrumResult = await runtime.spectrometer.acquireSpectrum({
			action: "spectrometer.acquire_spectrum",
			resourceId: runtime.spectrometer.resource.resourceId,
			acquisition,
			timeoutMs,
		});
		const payload = isRecord(spectrumResult.payload) ? spectrumResult.payload : {};
		const outputPath = readString(payload, "outputPath");
		const stateAfter: Record<string, unknown> = {
			...proposalState,
			actionStatus: spectrumResult.status,
			payload,
			artifactRefs: spectrumResult.artifacts,
		};

		if (spectrumResult.status !== "success") {
			return error(spectrumResult.summary, spectrumResult.errorCode ?? "spectrum_acquisition_failed", stateAfter, spectrumResult.retrySafe);
		}

		const summary = outputPath ? `Smoke spectrum acquired: ${outputPath}.` : "Smoke spectrum acquired.";
		return success(summary, stateAfter);
	},
} satisfies ToolDefinition<typeof SmokeSpectrumParamsSchema, OperatorToolDetails>;

export const ramanRunAutofocusTool = {
	name: "raman_run_autofocus",
	label: "Raman Autofocus",
	description: "Run a confirmed Z autofocus at the current XY position through the registered live Raman runtime.",
	promptSnippet: "Run autofocus before frame capture or point observation after explicit operator confirmation",
	promptGuidelines: [
		"Use this for operator requests to focus the current view or prepare a frame capture at the current XY position.",
		"Call first without confirmed=true to present the autofocus ROI, Z range, and motion warning.",
		"Call with confirmed=true only after explicit operator confirmation.",
		"Use bounded ProcedureSpec runs when autofocus is part of a real Raman acquisition, parameter search, or mapping.",
	],
	parameters: AutofocusParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: OperatorAutofocusParams, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const stageZRange = runtime.stage.resource.limits.zRangeUm;
		const minObjectiveClearanceUm = params.minObjectiveClearanceUm ?? DEFAULT_AUTOFOCUS_MIN_OBJECTIVE_CLEARANCE_UM;
		const zMinUm = Math.max(stageZRange[0], minObjectiveClearanceUm);
		const zMaxUm = stageZRange[1];
		const roi = params.roi ?? DEFAULT_AUTOFOCUS_ROI;
		const autofocusParams = {
			zStartUm: params.zStartUm,
			zEndUm: params.zEndUm,
			pointCount: params.pointCount,
			stageTimeoutMs: params.stageTimeoutMs,
			frameTimeoutMs: params.frameTimeoutMs,
			settleMs: params.settleMs,
			framesPerZ: params.framesPerZ,
			warmupFramesPerZ: params.warmupFramesPerZ,
			targetToleranceUm: params.targetToleranceUm,
			finalToleranceUm: params.finalToleranceUm,
			finalApproachOffsetUm: params.finalApproachOffsetUm,
			interpolatePeak: params.interpolatePeak,
			finalVerificationFramesPerZ: params.finalVerificationFramesPerZ,
			metricName: params.metricName,
		};
		const timeoutMs = params.timeoutMs ?? DEFAULT_AUTOFOCUS_TIMEOUT_MS;
		const proposalState: Record<string, unknown> = {
			stageResourceId: runtime.stage.resource.resourceId,
			frameProviderResourceId: runtime.frame.resource.resourceId,
			roi,
			params: autofocusParams,
			timeoutMs,
			stageZRangeUm: stageZRange,
			minObjectiveClearanceUm,
			requiresConfirmation: true,
			confirmed: params.confirmed === true,
		};

		if (zMinUm >= zMaxUm) {
			return error(
				`Autofocus zMinUm ${zMinUm} um must be below zMaxUm ${zMaxUm} um.`,
				"autofocus_invalid_z_range",
				proposalState,
				false,
			);
		}
		if (
			(params.zStartUm < zMinUm || params.zStartUm > zMaxUm || params.zEndUm < zMinUm || params.zEndUm > zMaxUm)
		) {
			return error(
				`Fixed-range autofocus bounds ${params.zStartUm}-${params.zEndUm} um must stay within allowed Z range ${zMinUm}-${zMaxUm} um.`,
				"autofocus_invalid_z_range",
				proposalState,
				false,
			);
		}

		if (params.confirmed !== true) {
			return warning(
				`Fixed-range autofocus requires explicit confirmation before Z motion. ROI: x=${roi.x}, y=${roi.y}, width=${roi.width}, height=${roi.height}; scan range: ${params.zStartUm}-${params.zEndUm} um; allowed Z range: ${zMinUm}-${zMaxUm} um.`,
				proposalState,
			);
		}

		const autofocusResult = await runtime.autofocus.runSingle({
			action: "autofocus.run_single",
			stageResourceId: runtime.stage.resource.resourceId,
			frameProviderResourceId: runtime.frame.resource.resourceId,
			roi,
			params: autofocusParams,
			timeoutMs,
		});
		const payload = isRecord(autofocusResult.payload) ? autofocusResult.payload : {};
		const zBestUm = readNumber(payload, "zBestUm");
		const stateAfter: Record<string, unknown> = {
			...proposalState,
			actionStatus: autofocusResult.status,
			payload,
			artifactRefs: autofocusResult.artifacts,
		};

		if (autofocusResult.status !== "success") {
			return error(autofocusResult.summary, autofocusResult.errorCode ?? "autofocus_failed", stateAfter, autofocusResult.retrySafe);
		}
		if (zBestUm !== undefined && (zBestUm < zMinUm || zBestUm > zMaxUm)) {
			return error(
				`Autofocus settled at Z=${zBestUm} um outside allowed Z range ${zMinUm}-${zMaxUm} um.`,
				"motion_out_of_bounds",
				stateAfter,
				false,
			);
		}

		const summary = zBestUm === undefined ? "Autofocus completed." : `Autofocus completed at Z=${zBestUm} um.`;
		return success(summary, stateAfter);
	},
} satisfies ToolDefinition<typeof AutofocusParamsSchema, OperatorToolDetails>;

export const ramanStageMoveRelativeTool = {
	name: "raman_stage_move_relative",
	label: "Raman Stage Move Relative",
	description: "Prepare or execute a confirmed relative Raman stage move through the live runtime.",
	promptSnippet: "Move the Raman stage by a small relative delta after explicit operator confirmation",
	promptGuidelines: [
		"Use this for operator-requested stage nudges, not Raman acquisition runs.",
		"Call first without confirmed=true to present the target and safety envelope, then call with confirmed=true only after explicit confirmation.",
	],
	parameters: StageRelativeMoveParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: StageRelativeMoveParams, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const timeoutMs = params.timeoutMs ?? 15_000;
		const positionResult = await readStagePosition(runtime, 10_000);
		if (positionResult.status !== "success") {
			return error(positionResult.summary, positionResult.errorCode ?? "stage_position_read_failed", {
				stageResourceId: runtime.stage.resource.resourceId,
				actionStatus: positionResult.status,
				payload: positionResult.payload ?? {},
			}, positionResult.retrySafe);
		}

		const current = positionFromActionResult(positionResult);
		if (!current) {
			return error("Stage position result did not include xUm, yUm, and zUm.", "invalid_stage_position_result", {
				stageResourceId: runtime.stage.resource.resourceId,
				payload: positionResult.payload ?? {},
			}, false);
		}

		const target = targetFromDelta(current, params.axis, params.deltaUm);
		const limitCheck = checkMoveLimits(runtime, target, params.axis, params.minObjectiveClearanceUm);
		if (!limitCheck.ok) {
			return error(limitCheck.message, limitCheck.code, {
				stageResourceId: runtime.stage.resource.resourceId,
				current,
				...limitCheck.state,
			}, false);
		}

		const proposalState = {
			stageResourceId: runtime.stage.resource.resourceId,
			axis: params.axis,
			deltaUm: params.deltaUm,
			current,
			target,
			stageLimits: runtime.stage.resource.limits,
			requiresConfirmation: true,
			confirmed: params.confirmed === true,
		};
		if (params.confirmed !== true) {
			return warning(
				`Stage relative move requires explicit confirmation before execution. Current: ${formatStagePosition(current)}. Target: ${formatStagePosition(target)}.`,
				proposalState,
			);
		}

		const moveResult = await runtime.stage.moveAbsoluteAndWait({
			action: "stage.move_absolute_and_wait",
			resourceId: runtime.stage.resource.resourceId,
			target,
			timeoutMs,
		});
		if (moveResult.status !== "success") {
			return error(moveResult.summary, moveResult.errorCode ?? "stage_move_failed", {
				...proposalState,
				actionStatus: moveResult.status,
				payload: moveResult.payload ?? {},
			}, moveResult.retrySafe);
		}

		return success(`Stage relative move completed. Target: ${formatStagePosition(target)}.`, {
			...proposalState,
			payload: moveResult.payload ?? {},
		});
	},
} satisfies ToolDefinition<typeof StageRelativeMoveParamsSchema, OperatorToolDetails>;
