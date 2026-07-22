import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import type {
	ExperimentIntent,
	ExecutionUnit,
	Point,
	ProcedureDomain,
	ProcedureId,
	ProcedureLimits,
	ProcedureSpec,
	ResourceRef,
	RamanParameterSearch,
	SemanticStep,
	StoppingRules,
	TemperatureDomain,
} from "../schemas/index.ts";

export type ProposalRiskLevel = "notice" | "confirm_required" | "forbidden";

export interface ProposalRisk {
	level: ProposalRiskLevel;
	code: string;
	message: string;
}

export interface ProcedureProposalPreview {
	risks: ProposalRisk[];
	limits: ProcedureLimits;
	estimatedRuntimeMs: number;
	savePath: string;
	requiresConfirmation: true;
	unitCount: number;
}

interface RamanResourceBindings {
	stageResourceId: string;
	frameProviderResourceId: string;
	spectrometerResourceId: string;
	temperatureControllerResourceId?: string;
}

interface RamanAcquisitionInput {
	integrationTimeMs: number;
	laserPowerPercent: number;
	accumulations: number;
	timeoutMs?: number;
	saveFormat?: "txt" | "csv";
}

interface AutofocusInput {
	enabled: boolean;
	roi: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	params?: {
		zStartUm?: number;
		zEndUm?: number;
		pointCount?: number;
		stageTimeoutMs?: number;
		frameTimeoutMs?: number;
		settleMs?: number;
		framesPerZ?: number;
		warmupFramesPerZ?: number;
		targetToleranceUm?: number;
		finalToleranceUm?: number;
		finalApproachOffsetUm?: number;
		interpolatePeak?: boolean;
		finalVerificationFramesPerZ?: number;
		metricName?: string;
	};
}

interface BaseProcedureBuilderInput {
	procedureSpecId?: string;
	procedureVersion?: string;
	intent: ExperimentIntent;
	resources: RamanResourceBindings;
	limits: ProcedureLimits;
	stoppingRules?: StoppingRules;
	autofocus: AutofocusInput;
	acquisition: RamanAcquisitionInput;
	interPointDelayMs?: number;
}

export interface SinglePointProbeBuilderInput extends BaseProcedureBuilderInput {
	procedureId: "raman_single_point_probe";
	point?: Point;
}

export interface ParameterSearchBuilderInput extends BaseProcedureBuilderInput {
	procedureId: "raman_parameter_search";
	point: Point;
	parameterSearch: RamanParameterSearch;
}

export interface GridMappingBuilderInput extends BaseProcedureBuilderInput {
	procedureId: "raman_grid_mapping";
	grid: {
		origin: { xUm: number; yUm: number; zUm?: number };
		rows: number;
		cols: number;
		pitchXUm: number;
		pitchYUm: number;
		order?: "row_major" | "snake";
	};
}

export interface TemperatureSeriesBuilderInput extends BaseProcedureBuilderInput {
	procedureId: "raman_temperature_series";
	targetsK: number[];
	temperature: TemperatureDomain;
}

export type ProcedureSpecBuilderInput =
	| SinglePointProbeBuilderInput
	| ParameterSearchBuilderInput
	| GridMappingBuilderInput
	| TemperatureSeriesBuilderInput;

const PER_ACTION_RUNTIME_MS: Record<SemanticStep["kind"], number> = {
	move_to_point: 2_000,
	autofocus: 3_000,
	set_temperature: 1_000,
	wait_for_temperature: 0,
	capture_frame: 750,
	acquire_spectrum: 1_000,
};

function generatedId(prefix: string): string {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function defaultActions(): SemanticStep[] {
	return [
		{ kind: "move_to_point" },
		{ kind: "autofocus" },
		{ kind: "capture_frame" },
		{ kind: "acquire_spectrum" },
	];
}

function toResourceRefs(resources: RamanResourceBindings): ResourceRef[] {
	const refs: ResourceRef[] = [
		{ resourceId: resources.stageResourceId, role: "stage" },
		{ resourceId: resources.frameProviderResourceId, role: "frame_provider" },
		{ resourceId: resources.spectrometerResourceId, role: "spectrometer" },
	];
	if (resources.temperatureControllerResourceId) {
		refs.push({ resourceId: resources.temperatureControllerResourceId, role: "temperature_controller" });
	}
	return refs;
}

function toDomain(input: ProcedureSpecBuilderInput): ProcedureDomain {
	return {
		raman: {
			autofocus: input.autofocus,
			acquisition: input.acquisition,
			parameterSearch: input.procedureId === "raman_parameter_search" ? input.parameterSearch : undefined,
		},
		temperature: input.procedureId === "raman_temperature_series" ? input.temperature : undefined,
	};
}

function createPlan(input: ProcedureSpecBuilderInput): ProcedureSpec["plan"] {
	if (input.procedureId === "raman_temperature_series") {
		return {
			kind: "temperature_series",
			targetsK: input.targetsK,
		};
	}

	if (input.procedureId === "raman_grid_mapping") {
		return {
			kind: "grid_scan",
			grid: input.grid,
			perPoint: defaultActions(),
			interPointDelayMs: input.interPointDelayMs,
		};
	}

	if (input.procedureId === "raman_parameter_search") {
		return {
			kind: "point_list",
			points: Array.from({ length: input.parameterSearch.maxAttempts }, () => ({ ...input.point })),
			perPoint: defaultActions(),
			interPointDelayMs: input.interPointDelayMs,
		};
	}

	if (!input.point) {
		return {
			kind: "current_position",
			perPoint: defaultActions(),
		};
	}

	return {
		kind: "point_list",
		points: [{ ...input.point }],
		perPoint: defaultActions(),
		interPointDelayMs: input.interPointDelayMs,
	};
}

function createSpec(input: ProcedureSpecBuilderInput): ProcedureSpec {
	if (input.procedureId === "raman_temperature_series" && !input.resources.temperatureControllerResourceId) {
		throw new Error("raman_temperature_series requires temperatureControllerResourceId");
	}
	return {
		procedureSpecId: input.procedureSpecId ?? generatedId("procedure-spec"),
		experimentId: input.intent.experimentId,
		intentId: input.intent.intentId,
		procedureId: input.procedureId,
		procedureVersion: input.procedureVersion ?? "0.1.0",
		resources: toResourceRefs(input.resources),
		limits: input.limits,
		plan: createPlan(input),
		stoppingRules: input.stoppingRules,
		domain: toDomain(input),
	};
}

function actionRuntimeMs(spec: ProcedureSpec, actionKind: SemanticStep["kind"]): number {
	if (actionKind === "wait_for_temperature") {
		const stability = spec.domain.temperature?.stability;
		return stability ? (stability.continuousHoldS + stability.postStableDwellS) * 1_000 : 0;
	}
	if (actionKind !== "acquire_spectrum") {
		return PER_ACTION_RUNTIME_MS[actionKind];
	}

	return (
		spec.domain.raman.acquisition.integrationTimeMs * spec.domain.raman.acquisition.accumulations +
		PER_ACTION_RUNTIME_MS.acquire_spectrum
	);
}

function classifyLaserRisk(spec: ProcedureSpec): ProposalRisk | undefined {
	const requestedPower = spec.domain.raman.acquisition.laserPowerPercent;
	const maxPower = spec.limits.maxLaserPowerPercent;
	if (maxPower !== undefined && requestedPower > maxPower) {
		return {
			level: "forbidden",
			code: "laser_power_limit_exceeded",
			message: `Requested laser power ${requestedPower}% exceeds maxLaserPowerPercent ${maxPower}%.`,
		};
	}
	if (requestedPower > 0) {
		return {
			level: "confirm_required",
			code: "laser_acquisition",
			message: "This run will trigger real Raman acquisition with laser exposure.",
		};
	}
	return undefined;
}

function hasPoint(unit: ExecutionUnit): unit is ExecutionUnit & { point: NonNullable<ExecutionUnit["point"]> } {
	return unit.point !== undefined;
}

function classifyMotionRangeRisks(spec: ProcedureSpec): ProposalRisk[] {
	if (spec.plan.kind === "current_position") {
		return [];
	}

	const points =
		spec.plan.kind === "point_list"
			? spec.plan.points
			: compileProcedureSpec(spec)
					.filter(hasPoint)
					.map((unit) => ({ xUm: unit.point.xUm, yUm: unit.point.yUm, zUm: unit.point.zUm }));
	const risks: ProposalRisk[] = [];

	for (const point of points) {
		if (spec.limits.xRangeUm && (point.xUm < spec.limits.xRangeUm.minUm || point.xUm > spec.limits.xRangeUm.maxUm)) {
			risks.push({
				level: "forbidden",
				code: "x_range_limit_exceeded",
				message: `Point x=${point.xUm} um is outside the allowed X range.`,
			});
			break;
		}
	}

	for (const point of points) {
		if (spec.limits.yRangeUm && (point.yUm < spec.limits.yRangeUm.minUm || point.yUm > spec.limits.yRangeUm.maxUm)) {
			risks.push({
				level: "forbidden",
				code: "y_range_limit_exceeded",
				message: `Point y=${point.yUm} um is outside the allowed Y range.`,
			});
			break;
		}
	}

	for (const point of points) {
		if (
			point.zUm !== undefined &&
			spec.limits.zRangeUm &&
			(point.zUm < spec.limits.zRangeUm.minUm || point.zUm > spec.limits.zRangeUm.maxUm)
		) {
			risks.push({
				level: "forbidden",
				code: "z_range_limit_exceeded",
				message: `Point z=${point.zUm} um is outside the allowed Z range.`,
			});
			break;
		}
	}

	return risks;
}

export function estimateProcedureRuntimeMs(spec: ProcedureSpec): number {
	const units = compileProcedureSpec(spec);
	return units.reduce(
		(total, unit) =>
			total +
			unit.actions.reduce((sum, action) => sum + actionRuntimeMs(spec, action.kind), 0) +
			(unit.interUnitDelayMs ?? 0),
		0,
	);
}

export function defaultProposalSavePath(spec: ProcedureSpec): string {
	return join("lab-records", "experiments", spec.experimentId, "planned-output", spec.procedureSpecId);
}

export function summarizeProcedureProposal(spec: ProcedureSpec): ProcedureProposalPreview {
	const units = compileProcedureSpec(spec);
	const hasStageMotion = units.some((unit) =>
		unit.actions.some((action) => action.kind === "move_to_point" || action.kind === "autofocus"),
	);
	const risks: ProposalRisk[] = hasStageMotion
		? [{
			level: "notice",
			code: "stage_motion",
			message:
				units.length > 1
					? "The stage will perform multiple real point visits during this bounded run."
					: "The stage will perform real motion during this bounded run.",
		}]
		: [];

	if (spec.procedureId === "raman_temperature_series") {
		risks.push({
			level: "notice",
			code: "temperature_control",
			message: "The run will change and hold the temperature controller target; output remains enabled after the run.",
		});
	}

	const laserRisk = classifyLaserRisk(spec);
	if (laserRisk) {
		risks.push(laserRisk);
	}

	risks.push(...classifyMotionRangeRisks(spec));

	if (spec.plan.kind === "grid_scan") {
		risks.push({
			level: "confirm_required",
			code: "multi_point_mapping",
			message: "This mapping run will execute repeated motion and Raman acquisition across the approved grid.",
		});
	}

	if (spec.procedureId === "raman_parameter_search") {
		risks.push({
			level: "confirm_required",
			code: "bounded_parameter_search",
			message: "This run is a bounded parameter search and will perform repeated supervised acquisitions within the approved envelope.",
		});
	}

	return {
		risks,
		limits: spec.limits,
		estimatedRuntimeMs: estimateProcedureRuntimeMs(spec),
		savePath: defaultProposalSavePath(spec),
		requiresConfirmation: true,
		unitCount: units.length,
	};
}

export function buildProcedureSpec(input: ProcedureSpecBuilderInput): ProcedureSpec {
	return createSpec(input);
}

export function buildProcedureProposal(input: ProcedureSpecBuilderInput): { spec: ProcedureSpec; preview: ProcedureProposalPreview } {
	const spec = createSpec(input);
	return {
		spec,
		preview: summarizeProcedureProposal(spec),
	};
}

export function procedureDisplayName(procedureId: ProcedureId): string {
	switch (procedureId) {
		case "raman_single_point_probe":
			return "single-point Raman probe";
		case "raman_parameter_search":
			return "bounded Raman parameter search";
		case "raman_grid_mapping":
			return "bounded Raman grid mapping";
		case "raman_temperature_series":
			return "bounded Raman temperature series";
	}
}
