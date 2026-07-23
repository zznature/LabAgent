import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../../schemas/tool-result.ts";
import { compileSchema } from "../../schemas/validation.ts";

export const ActionStatusSchema = Type.Union([
	Type.Literal("success"),
	Type.Literal("failed"),
	Type.Literal("paused"),
]);

export const ActionErrorSchema = Type.Object(
	{
		errorCode: Type.String({ minLength: 1 }),
		message: Type.String({ minLength: 1 }),
		retrySafe: Type.Boolean(),
		needsOperator: Type.Boolean(),
		safeToResume: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ActionResultSchema = Type.Object(
	{
		status: ActionStatusSchema,
		artifacts: Type.Array(ArtifactRefSchema),
		errorCode: Type.Optional(Type.String({ minLength: 1 })),
		retrySafe: Type.Boolean(),
		needsOperator: Type.Boolean(),
		safeToResume: Type.Boolean(),
		summary: Type.String({ minLength: 1 }),
		payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const ArtifactStagingContextSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		unitId: Type.String({ minLength: 1 }),
		attemptId: Type.String({ minLength: 1 }),
		actionId: Type.String({ minLength: 1 }),
		stagingDir: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const StageMoveAbsoluteAndWaitActionSchema = Type.Object(
	{
		action: Type.Literal("stage.move_absolute_and_wait"),
		resourceId: Type.String({ minLength: 1 }),
		target: Type.Object(
			{
				xUm: Type.Number(),
				yUm: Type.Number(),
				zUm: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
		timeoutMs: Type.Integer({ minimum: 1 }),
		artifactContext: Type.Optional(ArtifactStagingContextSchema),
	},
	{ additionalProperties: false },
);

export const StageGetPositionActionSchema = Type.Object(
	{
		action: Type.Literal("stage.get_position"),
		resourceId: Type.String({ minLength: 1 }),
		timeoutMs: Type.Integer({ minimum: 1 }),
		artifactContext: Type.Optional(ArtifactStagingContextSchema),
	},
	{ additionalProperties: false },
);

export const AutofocusRunSingleActionSchema = Type.Object(
	{
		action: Type.Literal("autofocus.run_single"),
		stageResourceId: Type.String({ minLength: 1 }),
		frameProviderResourceId: Type.String({ minLength: 1 }),
		roi: Type.Object(
			{
				x: Type.Integer({ minimum: 0 }),
				y: Type.Integer({ minimum: 0 }),
				width: Type.Integer({ minimum: 1 }),
				height: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
		params: Type.Object(
			{
				zStartUm: Type.Number(),
				zEndUm: Type.Number(),
				pointCount: Type.Optional(Type.Integer({ minimum: 3 })),
				stageTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
				frameTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
				settleMs: Type.Optional(Type.Integer({ minimum: 0 })),
				framesPerZ: Type.Optional(Type.Integer({ minimum: 1 })),
				warmupFramesPerZ: Type.Optional(Type.Integer({ minimum: 0 })),
				targetToleranceUm: Type.Optional(Type.Number({ minimum: 5 })),
				finalToleranceUm: Type.Optional(Type.Number({ minimum: 5 })),
				finalApproachOffsetUm: Type.Optional(Type.Number({ minimum: 0 })),
				interpolatePeak: Type.Optional(Type.Boolean()),
				finalVerificationFramesPerZ: Type.Optional(Type.Integer({ minimum: 1 })),
				metricName: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		timeoutMs: Type.Integer({ minimum: 1 }),
		artifactContext: Type.Optional(ArtifactStagingContextSchema),
	},
	{ additionalProperties: false },
);

export const FrameCaptureLatestActionSchema = Type.Object(
	{
		action: Type.Literal("frame.capture_latest"),
		resourceId: Type.String({ minLength: 1 }),
		timeoutMs: Type.Integer({ minimum: 1 }),
		artifactContext: Type.Optional(ArtifactStagingContextSchema),
	},
	{ additionalProperties: false },
);

export const FrameCaptureLaserOffActionSchema = Type.Object(
	{
		action: Type.Literal("frame.capture_laser_off"),
		resourceId: Type.String({ minLength: 1 }),
		timeoutMs: Type.Integer({ minimum: 1 }),
		discardFrames: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
		artifactContext: Type.Optional(ArtifactStagingContextSchema),
	},
	{ additionalProperties: false },
);

export const SpectrometerAcquireSpectrumActionSchema = Type.Object(
	{
		action: Type.Literal("spectrometer.acquire_spectrum"),
		resourceId: Type.String({ minLength: 1 }),
		acquisition: Type.Object(
			{
				integrationTimeMs: Type.Integer({ minimum: 1 }),
				laserPowerPercent: Type.Number({ minimum: 0, maximum: 100 }),
				accumulations: Type.Integer({ minimum: 1 }),
				saveFormat: Type.Optional(Type.Union([Type.Literal("txt"), Type.Literal("csv")])),
			},
			{ additionalProperties: false },
		),
		timeoutMs: Type.Integer({ minimum: 1 }),
		artifactContext: Type.Optional(ArtifactStagingContextSchema),
	},
	{ additionalProperties: false },
);

export const RamanRuntimeActionSchema = Type.Union([
	StageGetPositionActionSchema,
	StageMoveAbsoluteAndWaitActionSchema,
	AutofocusRunSingleActionSchema,
	FrameCaptureLatestActionSchema,
	FrameCaptureLaserOffActionSchema,
	SpectrometerAcquireSpectrumActionSchema,
]);

export type ActionStatus = Static<typeof ActionStatusSchema>;
export type ActionError = Static<typeof ActionErrorSchema>;
export type ActionResult = Static<typeof ActionResultSchema>;
export type ArtifactStagingContext = Static<typeof ArtifactStagingContextSchema>;
export type StageGetPositionAction = Static<typeof StageGetPositionActionSchema>;
export type StageMoveAbsoluteAndWaitAction = Static<typeof StageMoveAbsoluteAndWaitActionSchema>;
export type AutofocusRunSingleAction = Static<typeof AutofocusRunSingleActionSchema>;
export type FrameCaptureLatestAction = Static<typeof FrameCaptureLatestActionSchema>;
export type FrameCaptureLaserOffAction = Static<typeof FrameCaptureLaserOffActionSchema>;
export type SpectrometerAcquireSpectrumAction = Static<typeof SpectrometerAcquireSpectrumActionSchema>;
export type RamanRuntimeAction = Static<typeof RamanRuntimeActionSchema>;

export const ActionResultValidator = compileSchema(ActionResultSchema);
export const StageGetPositionActionValidator = compileSchema(StageGetPositionActionSchema);
export const StageMoveAbsoluteAndWaitActionValidator = compileSchema(StageMoveAbsoluteAndWaitActionSchema);
export const AutofocusRunSingleActionValidator = compileSchema(AutofocusRunSingleActionSchema);
export const FrameCaptureLatestActionValidator = compileSchema(FrameCaptureLatestActionSchema);
export const FrameCaptureLaserOffActionValidator = compileSchema(FrameCaptureLaserOffActionSchema);
export const SpectrometerAcquireSpectrumActionValidator = compileSchema(SpectrometerAcquireSpectrumActionSchema);
export const RamanRuntimeActionValidator = compileSchema(RamanRuntimeActionSchema);

export function successActionResult(
	summary: string,
	payload: Record<string, unknown> = {},
	artifacts: Static<typeof ArtifactRefSchema>[] = [],
): ActionResult {
	return {
		status: "success",
		artifacts,
		retrySafe: false,
		needsOperator: false,
		safeToResume: true,
		summary,
		payload,
	};
}

export function failedActionResult(summary: string, error: ActionError, payload: Record<string, unknown> = {}): ActionResult {
	return {
		status: "failed",
		artifacts: [],
		errorCode: error.errorCode,
		retrySafe: error.retrySafe,
		needsOperator: error.needsOperator,
		safeToResume: error.safeToResume,
		summary,
		payload: {
			...payload,
			error,
		},
	};
}

export function pausedActionResult(summary: string, payload: Record<string, unknown> = {}): ActionResult {
	return {
		status: "paused",
		artifacts: [],
		retrySafe: true,
		needsOperator: true,
		safeToResume: true,
		summary,
		payload,
	};
}
