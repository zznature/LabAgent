import { Type, type Static } from "typebox";
import { compileSchema } from "../../schemas/validation.ts";

export const RamanRuntimeKindSchema = Type.Literal("raman_python");

export const LeasePolicySchema = Type.Union([Type.Literal("exclusive"), Type.Literal("shared-read")]);

export const MotionRangeTupleSchema = Type.Tuple([Type.Number(), Type.Number()]);

export const StageResourceConfigSchema = Type.Object(
	{
		port: Type.String({ minLength: 1 }),
		xChannel: Type.Integer({ minimum: 0 }),
		yChannel: Type.Integer({ minimum: 0 }),
		zChannel: Type.Integer({ minimum: 0 }),
		baudrate: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const StageResourceLimitsSchema = Type.Object(
	{
		xRangeUm: MotionRangeTupleSchema,
		yRangeUm: MotionRangeTupleSchema,
		zRangeUm: MotionRangeTupleSchema,
	},
	{ additionalProperties: false },
);

export const StageResourceSchema = Type.Object(
	{
		resourceId: Type.String({ minLength: 1 }),
		kind: Type.Literal("stage"),
		runtime: RamanRuntimeKindSchema,
		driver: Type.String({ minLength: 1 }),
		config: StageResourceConfigSchema,
		leasePolicy: LeasePolicySchema,
		simulationAvailable: Type.Boolean(),
		limits: StageResourceLimitsSchema,
	},
	{ additionalProperties: false },
);

export const FrameProviderResourceConfigSchema = Type.Object(
	{
		bridgeDir: Type.String({ minLength: 1 }),
		imageFormat: Type.String({ minLength: 1 }),
		minCaptureIntervalMs: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const FrameProviderResourceSchema = Type.Object(
	{
		resourceId: Type.String({ minLength: 1 }),
		kind: Type.Literal("frame_provider"),
		runtime: RamanRuntimeKindSchema,
		driver: Type.String({ minLength: 1 }),
		config: FrameProviderResourceConfigSchema,
		leasePolicy: LeasePolicySchema,
		simulationAvailable: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const SpectrometerResourceConfigSchema = Type.Object(
	{
		bridgeDir: Type.String({ minLength: 1 }),
		requestFilename: Type.String({ minLength: 1 }),
		resultFilename: Type.String({ minLength: 1 }),
		laserPower: Type.Optional(
			Type.Object(
				{
					unit: Type.Literal("percent"),
					allowedPercentValues: Type.Array(Type.Number({ minimum: 0, maximum: 100 }), { minItems: 1 }),
					defaultPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
					maxAllowedPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const SpectrometerResourceSchema = Type.Object(
	{
		resourceId: Type.String({ minLength: 1 }),
		kind: Type.Literal("spectrometer"),
		runtime: RamanRuntimeKindSchema,
		driver: Type.String({ minLength: 1 }),
		config: SpectrometerResourceConfigSchema,
		leasePolicy: LeasePolicySchema,
		simulationAvailable: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const TemperatureResourceConfigSchema = Type.Object(
	{
		port: Type.String({ minLength: 1 }),
		baudrate: Type.Integer({ minimum: 1 }),
		channel: Type.Union([Type.Literal("A"), Type.Literal("B")]),
		controlMode: Type.Literal("A"),
		outputRange: Type.Literal("LOW"),
		defaultRampKPerMin: Type.Number({ exclusiveMinimum: 0 }),
	},
	{ additionalProperties: false },
);

export const TemperatureOperatingRangeSchema = Type.Object(
	{
		minTargetK: Type.Number({ exclusiveMinimum: 0 }),
		maxTargetK: Type.Number({ exclusiveMinimum: 0 }),
		maxRampKPerMin: Type.Number({ exclusiveMinimum: 0 }),
	},
	{ additionalProperties: false },
);

export const TemperatureResourceSchema = Type.Object(
	{
		resourceId: Type.String({ minLength: 1 }),
		kind: Type.Literal("temperature_controller"),
		runtime: RamanRuntimeKindSchema,
		driver: Type.Literal("kelvinion_mini"),
		config: TemperatureResourceConfigSchema,
		leasePolicy: Type.Literal("exclusive"),
		simulationAvailable: Type.Boolean(),
		operatingRange: TemperatureOperatingRangeSchema,
	},
	{ additionalProperties: false },
);

export const RamanResourceSchema = Type.Union([
	StageResourceSchema,
	FrameProviderResourceSchema,
	SpectrometerResourceSchema,
	TemperatureResourceSchema,
]);

export type RamanRuntimeKind = Static<typeof RamanRuntimeKindSchema>;
export type LeasePolicy = Static<typeof LeasePolicySchema>;
export type StageResourceConfig = Static<typeof StageResourceConfigSchema>;
export type StageResourceLimits = Static<typeof StageResourceLimitsSchema>;
export type StageResource = Static<typeof StageResourceSchema>;
export type FrameProviderResourceConfig = Static<typeof FrameProviderResourceConfigSchema>;
export type FrameProviderResource = Static<typeof FrameProviderResourceSchema>;
export type SpectrometerResourceConfig = Static<typeof SpectrometerResourceConfigSchema>;
export type SpectrometerResource = Static<typeof SpectrometerResourceSchema>;
export type TemperatureResourceConfig = Static<typeof TemperatureResourceConfigSchema>;
export type TemperatureOperatingRange = Static<typeof TemperatureOperatingRangeSchema>;
export type TemperatureResource = Static<typeof TemperatureResourceSchema>;
export type RamanResource = Static<typeof RamanResourceSchema>;

export const StageResourceValidator = compileSchema(StageResourceSchema);
export const FrameProviderResourceValidator = compileSchema(FrameProviderResourceSchema);
export const SpectrometerResourceValidator = compileSchema(SpectrometerResourceSchema);
export const TemperatureResourceValidator = compileSchema(TemperatureResourceSchema);
export const RamanResourceValidator = compileSchema(RamanResourceSchema);
