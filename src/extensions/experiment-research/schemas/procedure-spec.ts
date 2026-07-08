import { Type, type Static } from "typebox";
import { compileSchema } from "./validation.ts";

export const ResourceRefSchema = Type.Object(
	{
		resourceId: Type.String({ minLength: 1 }),
		role: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const PointSchema = Type.Object(
	{
		xUm: Type.Number(),
		yUm: Type.Number(),
		zUm: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const GridPointSchema = Type.Object(
	{
		xUm: Type.Number(),
		yUm: Type.Number(),
	},
	{ additionalProperties: false },
);

export const SemanticStepSchema = Type.Union([
	Type.Object({ kind: Type.Literal("move_to_point") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("autofocus") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("capture_frame") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("acquire_spectrum") }, { additionalProperties: false }),
]);

export const MotionAxisRangeSchema = Type.Object(
	{
		minUm: Type.Number(),
		maxUm: Type.Number(),
	},
	{ additionalProperties: false },
);

export const ProcedureLimitsSchema = Type.Object(
	{
		maxLaserPowerPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
		minObjectiveClearanceUm: Type.Optional(Type.Number({ minimum: 0 })),
		xRangeUm: Type.Optional(MotionAxisRangeSchema),
		yRangeUm: Type.Optional(MotionAxisRangeSchema),
		zRangeUm: Type.Optional(MotionAxisRangeSchema),
	},
	{ additionalProperties: false },
);

export const StoppingRulesSchema = Type.Object(
	{
		maxRuntimeMinutes: Type.Optional(Type.Number({ minimum: 0 })),
		maxUnits: Type.Optional(Type.Integer({ minimum: 1 })),
		stopOnError: Type.Optional(Type.Boolean()),
		maxConsecutiveFailures: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const RamanAutofocusSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		roi: Type.Object(
			{
				x: Type.Integer({ minimum: 0 }),
				y: Type.Integer({ minimum: 0 }),
				width: Type.Integer({ minimum: 1 }),
				height: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
		params: Type.Optional(
			Type.Object(
				{
					zStartUm: Type.Optional(Type.Number()),
					zEndUm: Type.Optional(Type.Number()),
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
		),
	},
	{ additionalProperties: false },
);

export const RamanAcquisitionSchema = Type.Object(
	{
		integrationTimeMs: Type.Integer({ minimum: 1 }),
		laserPowerPercent: Type.Number({ minimum: 0, maximum: 100 }),
		accumulations: Type.Integer({ minimum: 1 }),
		saveFormat: Type.Optional(Type.Union([Type.Literal("txt"), Type.Literal("csv")])),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const RamanNumericRangeSchema = Type.Object(
	{
		min: Type.Number({ minimum: 0 }),
		max: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const RamanParameterSearchSchema = Type.Object(
	{
		maxAttempts: Type.Integer({ minimum: 1 }),
		laserPowerPercentValues: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 100 }), { minItems: 1 })),
		integrationTimeMs: Type.Optional(
			Type.Object(
				{
					min: Type.Integer({ minimum: 1 }),
					max: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		),
		accumulations: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 })),
	},
	{ additionalProperties: false },
);

export const RamanDomainSchema = Type.Object(
	{
		autofocus: RamanAutofocusSchema,
		acquisition: RamanAcquisitionSchema,
		parameterSearch: Type.Optional(RamanParameterSearchSchema),
	},
	{ additionalProperties: false },
);

export const ProcedureDomainSchema = Type.Object(
	{
		raman: RamanDomainSchema,
	},
	{ additionalProperties: false },
);

export const GridScanPlanSchema = Type.Object(
	{
		kind: Type.Literal("grid_scan"),
		grid: Type.Object(
			{
				origin: GridPointSchema,
				rows: Type.Integer({ minimum: 1 }),
				cols: Type.Integer({ minimum: 1 }),
				pitchXUm: Type.Number({ exclusiveMinimum: 0 }),
				pitchYUm: Type.Number({ exclusiveMinimum: 0 }),
				order: Type.Optional(Type.Union([Type.Literal("row_major"), Type.Literal("snake")])),
			},
			{ additionalProperties: false },
		),
		perPoint: Type.Array(SemanticStepSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const PointListPlanSchema = Type.Object(
	{
		kind: Type.Literal("point_list"),
		points: Type.Array(PointSchema, { minItems: 1 }),
		perPoint: Type.Array(SemanticStepSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const CurrentPositionPlanSchema = Type.Object(
	{
		kind: Type.Literal("current_position"),
		perPoint: Type.Array(SemanticStepSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const ProcedurePlanSchema = Type.Union([GridScanPlanSchema, PointListPlanSchema, CurrentPositionPlanSchema]);

export const ProcedureIdSchema = Type.Union([
	Type.Literal("raman_single_point_probe"),
	Type.Literal("raman_parameter_search"),
	Type.Literal("raman_grid_mapping"),
]);

export const ProcedureSpecSchema = Type.Object(
	{
		procedureSpecId: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		intentId: Type.String({ minLength: 1 }),
		procedureId: ProcedureIdSchema,
		procedureVersion: Type.String({ minLength: 1 }),
		resources: Type.Array(ResourceRefSchema, { minItems: 1 }),
		limits: ProcedureLimitsSchema,
		plan: ProcedurePlanSchema,
		stoppingRules: Type.Optional(StoppingRulesSchema),
		domain: ProcedureDomainSchema,
	},
	{ additionalProperties: false },
);

export type ResourceRef = Static<typeof ResourceRefSchema>;
export type Point = Static<typeof PointSchema>;
export type SemanticStep = Static<typeof SemanticStepSchema>;
export type ProcedureLimits = Static<typeof ProcedureLimitsSchema>;
export type StoppingRules = Static<typeof StoppingRulesSchema>;
export type RamanAutofocus = Static<typeof RamanAutofocusSchema>;
export type RamanAcquisition = Static<typeof RamanAcquisitionSchema>;
export type RamanParameterSearch = Static<typeof RamanParameterSearchSchema>;
export type RamanDomain = Static<typeof RamanDomainSchema>;
export type ProcedureDomain = Static<typeof ProcedureDomainSchema>;
export type GridScanPlan = Static<typeof GridScanPlanSchema>;
export type PointListPlan = Static<typeof PointListPlanSchema>;
export type CurrentPositionPlan = Static<typeof CurrentPositionPlanSchema>;
export type ProcedurePlan = Static<typeof ProcedurePlanSchema>;
export type ProcedureId = Static<typeof ProcedureIdSchema>;
export type ProcedureSpec = Static<typeof ProcedureSpecSchema>;

export const ProcedureSpecValidator = compileSchema(ProcedureSpecSchema);
