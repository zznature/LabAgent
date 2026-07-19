import { Type, type Static } from "typebox";
import { ProcedureLimitsSchema, SemanticStepSchema } from "./procedure-spec.ts";
import { compileSchema } from "./validation.ts";

export const ExecutionUnitKindSchema = Type.Union([
	Type.Literal("point"),
	Type.Literal("step"),
	Type.Literal("batch"),
]);

export const ExecutionUnitPointSchema = Type.Object(
	{
		row: Type.Optional(Type.Integer({ minimum: 0 })),
		col: Type.Optional(Type.Integer({ minimum: 0 })),
		xUm: Type.Number(),
		yUm: Type.Number(),
		zUm: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const ExecutionUnitPositionRefSchema = Type.Union([Type.Literal("absolute"), Type.Literal("current")]);

export const ArtifactScopeSchema = Type.Object(
	{
		artifactPathPrefix: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const ExecutionUnitSchema = Type.Object(
	{
		unitId: Type.String({ minLength: 1 }),
		index: Type.Integer({ minimum: 0 }),
		unitKind: ExecutionUnitKindSchema,
		positionRef: Type.Optional(ExecutionUnitPositionRefSchema),
		point: Type.Optional(ExecutionUnitPointSchema),
		actions: Type.Array(SemanticStepSchema, { minItems: 1 }),
		limits: ProcedureLimitsSchema,
		interUnitDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
		resumeKey: Type.String({ minLength: 1 }),
		artifactScope: ArtifactScopeSchema,
	},
	{ additionalProperties: false },
);

export type ExecutionUnitKind = Static<typeof ExecutionUnitKindSchema>;
export type ExecutionUnitPoint = Static<typeof ExecutionUnitPointSchema>;
export type ExecutionUnitPositionRef = Static<typeof ExecutionUnitPositionRefSchema>;
export type ArtifactScope = Static<typeof ArtifactScopeSchema>;
export type ExecutionUnit = Static<typeof ExecutionUnitSchema>;

export const ExecutionUnitValidator = compileSchema(ExecutionUnitSchema);
