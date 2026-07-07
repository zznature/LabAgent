import { Type, type Static } from "typebox";
import { compileSchema } from "./validation.ts";

export const ArtifactRefSchema = Type.Object(
	{
		artifactId: Type.String({ minLength: 1 }),
		kind: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
		label: Type.Optional(Type.String({ minLength: 1 })),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const RuntimeErrorScopeSchema = Type.Union([
	Type.Literal("action"),
	Type.Literal("unit"),
	Type.Literal("run"),
]);

export const RuntimeErrorSchema = Type.Object(
	{
		errorCode: Type.String({ minLength: 1 }),
		message: Type.String({ minLength: 1 }),
		retrySafe: Type.Boolean(),
		needsOperator: Type.Boolean(),
		safeToResume: Type.Boolean(),
		scope: Type.Optional(RuntimeErrorScopeSchema),
		payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const ToolResultStatusSchema = Type.Union([
	Type.Literal("success"),
	Type.Literal("warning"),
	Type.Literal("error"),
]);

export const ToolResultSchema = Type.Object(
	{
		status: ToolResultStatusSchema,
		summary: Type.String({ minLength: 1 }),
		runId: Type.Optional(Type.String({ minLength: 1 })),
		artifactRefs: Type.Optional(Type.Array(ArtifactRefSchema)),
		error: Type.Optional(RuntimeErrorSchema),
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export type ArtifactRef = Static<typeof ArtifactRefSchema>;
export type RuntimeErrorScope = Static<typeof RuntimeErrorScopeSchema>;
export type RuntimeError = Static<typeof RuntimeErrorSchema>;
export type ToolResultStatus = Static<typeof ToolResultStatusSchema>;
export type ToolResult = Static<typeof ToolResultSchema>;

export const ArtifactRefValidator = compileSchema(ArtifactRefSchema);
export const RuntimeErrorValidator = compileSchema(RuntimeErrorSchema);
export const ToolResultValidator = compileSchema(ToolResultSchema);
