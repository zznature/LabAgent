import { Type, type Static } from "typebox";
import { RetryFailureReasonSchema, RetryFailureTypeSchema } from "./procedure-spec.ts";
import { ArtifactRefSchema, RuntimeErrorSchema } from "./tool-result.ts";
import { compileSchema } from "./validation.ts";

export const RunStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("paused"),
	Type.Literal("aborted"),
	Type.Literal("failed"),
	Type.Literal("completed"),
]);

export const RunProgressSchema = Type.Object(
	{
		completedUnits: Type.Integer({ minimum: 0 }),
		failedUnits: Type.Optional(Type.Integer({ minimum: 0 })),
		totalUnits: Type.Optional(Type.Integer({ minimum: 0 })),
		unitKind: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const FOCUS_CENTER_POLICY = "previous_successful_then_current_point" as const;
export const FocusCenterPolicySchema = Type.Literal(FOCUS_CENTER_POLICY);

export const CurrentUnitRefSchema = Type.Object(
	{
		unitId: Type.String({ minLength: 1 }),
		index: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const PointAttemptPhaseSchema = Type.Union([
	Type.Literal("initial"),
	Type.Literal("immediate_retry"),
	Type.Literal("final_retry"),
]);

export const PointAttemptStatusSchema = Type.Union([
	Type.Literal("succeeded"),
	Type.Literal("failed"),
]);

export const PointAttemptRecordSchema = Type.Object(
	{
		pointUnitId: Type.String({ minLength: 1 }),
		attemptId: Type.String({ minLength: 1 }),
		attemptIndex: Type.Integer({ minimum: 0 }),
		phase: PointAttemptPhaseSchema,
		status: PointAttemptStatusSchema,
		failureType: Type.Optional(RetryFailureTypeSchema),
		failureReason: Type.Optional(RetryFailureReasonSchema),
		errorCode: Type.Optional(Type.String({ minLength: 1 })),
		message: Type.Optional(Type.String({ minLength: 1 })),
		finalForPoint: Type.Optional(Type.Boolean()),
		artifactIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		timestamp: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const RunExecutionModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("live-supervised"),
]);

export const RunStateSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		procedureSpecId: Type.String({ minLength: 1 }),
		executionMode: Type.Optional(RunExecutionModeSchema),
		status: RunStatusSchema,
		progress: RunProgressSchema,
		currentUnit: Type.Optional(CurrentUnitRefSchema),
		heartbeatAt: Type.Optional(Type.String({ minLength: 1 })),
		pauseReason: Type.Optional(Type.String({ minLength: 1 })),
		abortReason: Type.Optional(Type.String({ minLength: 1 })),
		errorState: Type.Optional(RuntimeErrorSchema),
		qualityState: Type.Optional(Type.String({ minLength: 1 })),
		lastAcceptedFocusZUm: Type.Optional(Type.Number()),
		focusCenterPolicy: Type.Optional(FocusCenterPolicySchema),
		pointAttempts: Type.Optional(Type.Array(PointAttemptRecordSchema)),
		artifactRefs: Type.Array(ArtifactRefSchema),
		resumedFromUnitIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		startedAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		endedAt: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type RunStatus = Static<typeof RunStatusSchema>;
export type RunExecutionMode = Static<typeof RunExecutionModeSchema>;
export type RunProgress = Static<typeof RunProgressSchema>;
export type FocusCenterPolicy = Static<typeof FocusCenterPolicySchema>;
export type CurrentUnitRef = Static<typeof CurrentUnitRefSchema>;
export type PointAttemptPhase = Static<typeof PointAttemptPhaseSchema>;
export type PointAttemptStatus = Static<typeof PointAttemptStatusSchema>;
export type PointAttemptRecord = Static<typeof PointAttemptRecordSchema>;
export type RunState = Static<typeof RunStateSchema>;

export const RunStateValidator = compileSchema(RunStateSchema);
