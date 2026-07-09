import { Type, type Static } from "typebox";
import {
	ProcedureDomainSchema,
	ProcedureIdSchema,
	ProcedureLimitsSchema,
	ResourceRefSchema,
	RetryPolicySchema,
	SemanticStepSchema,
	StoppingRulesSchema,
} from "./procedure-spec.ts";
import { compileSchema } from "./validation.ts";

export const ExperimentProcedureTemplateMatchSchema = Type.Object(
	{
		sampleIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		sampleClasses: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		intentKeywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		intentTags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		defaultForProcedure: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ExperimentProcedureTemplateDefaultsSchema = Type.Object(
	{
		resources: Type.Optional(Type.Array(ResourceRefSchema, { minItems: 1 })),
		limits: Type.Optional(ProcedureLimitsSchema),
		planPerPoint: Type.Optional(Type.Array(SemanticStepSchema, { minItems: 1 })),
		stoppingRules: Type.Optional(StoppingRulesSchema),
		retryPolicy: Type.Optional(RetryPolicySchema),
		domain: Type.Optional(ProcedureDomainSchema),
	},
	{ additionalProperties: false },
);

export const ExperimentProcedureTemplateSchema = Type.Object(
	{
		templateId: Type.String({ minLength: 1 }),
		templateVersion: Type.String({ minLength: 1 }),
		procedureId: ProcedureIdSchema,
		label: Type.String({ minLength: 1 }),
		description: Type.Optional(Type.String({ minLength: 1 })),
		match: ExperimentProcedureTemplateMatchSchema,
		defaults: ExperimentProcedureTemplateDefaultsSchema,
		source: Type.Optional(
			Type.Object(
				{
					kind: Type.Union([
						Type.Literal("user_workspace"),
						Type.Literal("derived_from_history"),
						Type.Literal("auto_sedimented_success"),
					]),
					ref: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		notes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	},
	{ additionalProperties: false },
);

export const ExperimentProcedureTemplateValidator = compileSchema(ExperimentProcedureTemplateSchema);

export type ExperimentProcedureTemplateMatch = Static<typeof ExperimentProcedureTemplateMatchSchema>;
export type ExperimentProcedureTemplateDefaults = Static<typeof ExperimentProcedureTemplateDefaultsSchema>;
export type ExperimentProcedureTemplate = Static<typeof ExperimentProcedureTemplateSchema>;
