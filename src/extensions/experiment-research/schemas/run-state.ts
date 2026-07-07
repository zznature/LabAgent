import { Type, type Static } from "typebox";
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

export const CurrentUnitRefSchema = Type.Object(
	{
		unitId: Type.String({ minLength: 1 }),
		index: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const RunStateSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		procedureSpecId: Type.String({ minLength: 1 }),
		status: RunStatusSchema,
		progress: RunProgressSchema,
		currentUnit: Type.Optional(CurrentUnitRefSchema),
		heartbeatAt: Type.Optional(Type.String({ minLength: 1 })),
		pauseReason: Type.Optional(Type.String({ minLength: 1 })),
		abortReason: Type.Optional(Type.String({ minLength: 1 })),
		errorState: Type.Optional(RuntimeErrorSchema),
		qualityState: Type.Optional(Type.String({ minLength: 1 })),
		artifactRefs: Type.Array(ArtifactRefSchema),
		startedAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		endedAt: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type RunStatus = Static<typeof RunStatusSchema>;
export type RunProgress = Static<typeof RunProgressSchema>;
export type CurrentUnitRef = Static<typeof CurrentUnitRefSchema>;
export type RunState = Static<typeof RunStateSchema>;

export const RunStateValidator = compileSchema(RunStateSchema);
