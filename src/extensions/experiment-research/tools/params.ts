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

export const ProcedureSpecParamsSchema = Type.Object(
	{
		spec: ProcedureSpecSchema,
		executionMode: Type.Optional(ExecutionModeSchema),
	},
	{ additionalProperties: false },
);

export const RunProcedureParamsSchema = Type.Object(
	{
		spec: ProcedureSpecSchema,
		simulation: Type.Optional(SimulationControlsSchema),
		executionMode: Type.Optional(ExecutionModeSchema),
		admission: Type.Optional(AdmissionSchema),
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
export type ProcedureSpecParams = Static<typeof ProcedureSpecParamsSchema>;
export type RunProcedureParams = Static<typeof RunProcedureParamsSchema>;
export type ProposalIdParams = Static<typeof ProposalIdParamsSchema>;
export type RunIdParams = Static<typeof RunIdParamsSchema>;
