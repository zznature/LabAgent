import { Type, type Static } from "typebox";
import { compileSchema } from "./validation.ts";

export const RamanEvaluationParameterSchema = Type.Union([
	Type.Literal("laserPowerPercent"),
	Type.Literal("integrationTimeMs"),
	Type.Literal("accumulations"),
]);

export const RamanObservationMetricsSchema = Type.Object(
	{
		autofocusConfidence: Type.Number({ minimum: 0, maximum: 1 }),
		saturated: Type.Boolean(),
		snr: Type.Number({ minimum: 0 }),
		targetPeakBaselineRatio: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const RamanEvaluationMetricsSchema = Type.Object(
	{
		attemptIndex: Type.Integer({ minimum: 0 }),
		current: RamanObservationMetricsSchema,
		recentObservations: Type.Array(RamanObservationMetricsSchema),
	},
	{ additionalProperties: false },
);

export const RamanEvaluationConfigSchema = Type.Object(
	{
		autofocusConfidenceMin: Type.Number({ minimum: 0, maximum: 1 }),
		snrMin: Type.Number({ minimum: 0 }),
		targetPeakBaselineRatioMin: Type.Number({ minimum: 0 }),
		repeatWindowSize: Type.Integer({ minimum: 1 }),
		repeatPassesRequired: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const RamanSearchEnvelopeSchema = Type.Object(
	{
		allowedParameters: Type.Array(RamanEvaluationParameterSchema, { minItems: 1 }),
		maxAttempts: Type.Integer({ minimum: 1 }),
		forbiddenExpansions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const RamanThresholdCheckSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		passed: Type.Boolean(),
		observed: Type.Number(),
		threshold: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RamanBooleanCheckSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		passed: Type.Boolean(),
		observed: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const RamanConsistencyCheckSchema = Type.Object(
	{
		name: Type.Literal("repeat_consistency"),
		passed: Type.Boolean(),
		windowSize: Type.Integer({ minimum: 1 }),
		passesRequired: Type.Integer({ minimum: 1 }),
		passesObserved: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const RamanEvaluationDecisionKindSchema = Type.Union([
	Type.Literal("acceptable"),
	Type.Literal("continue_search_within_envelope"),
	Type.Literal("stop_and_request_user_decision"),
]);

export const RamanEvaluationDecisionSchema = Type.Object(
	{
		decision: RamanEvaluationDecisionKindSchema,
		reasons: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		thresholdChecks: Type.Array(RamanThresholdCheckSchema),
		booleanChecks: Type.Array(RamanBooleanCheckSchema),
		consistencyCheck: RamanConsistencyCheckSchema,
		envelope: Type.Optional(RamanSearchEnvelopeSchema),
	},
	{ additionalProperties: false },
);

export type RamanEvaluationParameter = Static<typeof RamanEvaluationParameterSchema>;
export type RamanObservationMetrics = Static<typeof RamanObservationMetricsSchema>;
export type RamanEvaluationMetrics = Static<typeof RamanEvaluationMetricsSchema>;
export type RamanEvaluationConfig = Static<typeof RamanEvaluationConfigSchema>;
export type RamanSearchEnvelope = Static<typeof RamanSearchEnvelopeSchema>;
export type RamanThresholdCheck = Static<typeof RamanThresholdCheckSchema>;
export type RamanBooleanCheck = Static<typeof RamanBooleanCheckSchema>;
export type RamanConsistencyCheck = Static<typeof RamanConsistencyCheckSchema>;
export type RamanEvaluationDecisionKind = Static<typeof RamanEvaluationDecisionKindSchema>;
export type RamanEvaluationDecision = Static<typeof RamanEvaluationDecisionSchema>;

export const RamanObservationMetricsValidator = compileSchema(RamanObservationMetricsSchema);
export const RamanEvaluationMetricsValidator = compileSchema(RamanEvaluationMetricsSchema);
export const RamanEvaluationConfigValidator = compileSchema(RamanEvaluationConfigSchema);
export const RamanSearchEnvelopeValidator = compileSchema(RamanSearchEnvelopeSchema);
export const RamanEvaluationDecisionValidator = compileSchema(RamanEvaluationDecisionSchema);
