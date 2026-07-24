import { Type, type Static } from "typebox";
import { ProcedureSpecSchema } from "../schemas/procedure-spec.ts";

export const ExecutionModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("live-supervised"),
]);

export const AdmissionSchema = Type.Object(
	{
		preflightReady: Type.Boolean(),
		controlAvailable: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const OperatorApprovalSchema = Type.Object(
	{
		acknowledgedProposalId: Type.String({ minLength: 1 }),
		acknowledgedSpecHash: Type.String({ minLength: 1 }),
		approvedBy: Type.Literal("user"),
		approvedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const SimulationControlsSchema = Type.Object(
	{
		perUnitDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
		autofocusLowConfidenceAtUnit: Type.Optional(Type.Integer({ minimum: 0 })),
		autofocusLowConfidenceAtUnits: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		spectrumTimeoutAtUnit: Type.Optional(Type.Integer({ minimum: 0 })),
		spectrumTimeoutAtUnits: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		operatorPauseAtUnit: Type.Optional(Type.Integer({ minimum: 0 })),
		parameterSearchObservations: Type.Optional(
			Type.Array(
				Type.Object(
					{
						autofocusConfidence: Type.Number({ minimum: 0, maximum: 1 }),
						saturated: Type.Boolean(),
						snr: Type.Number({ minimum: 0 }),
						targetPeakBaselineRatio: Type.Number({ minimum: 0 }),
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);

export const TemplateApplicationSchema = Type.Object(
	{
		templateId: Type.String({ minLength: 1 }),
		templateVersion: Type.String({ minLength: 1 }),
		matchReason: Type.Optional(Type.String({ minLength: 1 })),
		inheritedFields: Type.Array(Type.String({ minLength: 1 })),
		overriddenFields: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		notes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);

export const ProcedureSpecParamsSchema = Type.Object(
	{
		spec: ProcedureSpecSchema,
		executionMode: Type.Optional(ExecutionModeSchema),
		templateApplication: Type.Optional(TemplateApplicationSchema),
	},
	{ additionalProperties: false },
);

export const RunProcedureParamsSchema = Type.Object(
	{
		spec: ProcedureSpecSchema,
		simulation: Type.Optional(SimulationControlsSchema),
		executionMode: Type.Optional(ExecutionModeSchema),
		admission: Type.Optional(AdmissionSchema),
		templateApplication: Type.Optional(TemplateApplicationSchema),
	},
	{ additionalProperties: false },
);

export const ProposalIdParamsSchema = Type.Object(
	{
		proposalId: Type.String({ minLength: 1 }),
		spec: ProcedureSpecSchema,
		simulation: Type.Optional(SimulationControlsSchema),
		executionMode: Type.Optional(ExecutionModeSchema),
		admission: Type.Optional(AdmissionSchema),
		operatorApproval: Type.Optional(OperatorApprovalSchema),
	},
	{ additionalProperties: false },
);

export const RunIdParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type ExecutionMode = Static<typeof ExecutionModeSchema>;
export type Admission = Static<typeof AdmissionSchema>;
export type OperatorApproval = Static<typeof OperatorApprovalSchema>;
export type TemplateApplication = Static<typeof TemplateApplicationSchema>;
export type ProcedureSpecParams = Static<typeof ProcedureSpecParamsSchema>;
export type RunProcedureParams = Static<typeof RunProcedureParamsSchema>;
export type ProposalIdParams = Static<typeof ProposalIdParamsSchema>;
export type RunIdParams = Static<typeof RunIdParamsSchema>;
