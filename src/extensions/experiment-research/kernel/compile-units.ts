import type {
	ExecutionUnit,
	ExecutionUnitPoint,
} from "../schemas/execution-unit.ts";
import { ExecutionUnitValidator } from "../schemas/execution-unit.ts";
import type { CurrentPositionPlan, GridScanPlan, Point, PointListPlan, ProcedureSpec } from "../schemas/procedure-spec.ts";
import { formatValidationErrors } from "../schemas/validation.ts";

function formatUnitIndex(index: number): string {
	return String(index).padStart(4, "0");
}

function createUnitId(procedureSpecId: string, index: number): string {
	return `${procedureSpecId}:unit:${formatUnitIndex(index)}`;
}

function createResumeKey(procedureSpecId: string, index: number): string {
	return `${procedureSpecId}/unit/${formatUnitIndex(index)}`;
}

function createArtifactPrefix(procedureSpecId: string, index: number): string {
	return `records/${procedureSpecId}/unit-${formatUnitIndex(index)}`;
}

function toExecutionPoint(point: Point, row?: number, col?: number): ExecutionUnitPoint {
	return {
		row,
		col,
		xUm: point.xUm,
		yUm: point.yUm,
		zUm: point.zUm,
	};
}

function buildPointListUnits(spec: ProcedureSpec, plan: PointListPlan): ExecutionUnit[] {
	return plan.points.map((point, index) => ({
		unitId: createUnitId(spec.procedureSpecId, index),
		index,
		unitKind: "point",
		positionRef: "absolute",
		point: toExecutionPoint(point),
		actions: plan.perPoint,
		limits: spec.limits,
		resumeKey: createResumeKey(spec.procedureSpecId, index),
		artifactScope: {
			artifactPathPrefix: createArtifactPrefix(spec.procedureSpecId, index),
		},
	}));
}

function buildGridPoints(plan: GridScanPlan): ExecutionUnitPoint[] {
	const points: ExecutionUnitPoint[] = [];
	for (let row = 0; row < plan.grid.rows; row++) {
		const columns = Array.from({ length: plan.grid.cols }, (_, column) => column);
		if (plan.grid.order === "snake" && row % 2 === 1) {
			columns.reverse();
		}
		for (const col of columns) {
			points.push({
				row,
				col,
				xUm: plan.grid.origin.xUm + col * plan.grid.pitchXUm,
				yUm: plan.grid.origin.yUm + row * plan.grid.pitchYUm,
			});
		}
	}
	return points;
}

function buildGridScanUnits(spec: ProcedureSpec, plan: GridScanPlan): ExecutionUnit[] {
	return buildGridPoints(plan).map((point, index) => ({
		unitId: createUnitId(spec.procedureSpecId, index),
		index,
		unitKind: "point",
		positionRef: "absolute",
		point,
		actions: plan.perPoint,
		limits: spec.limits,
		resumeKey: createResumeKey(spec.procedureSpecId, index),
		artifactScope: {
			artifactPathPrefix: createArtifactPrefix(spec.procedureSpecId, index),
		},
	}));
}

function buildCurrentPositionUnit(spec: ProcedureSpec, plan: CurrentPositionPlan): ExecutionUnit[] {
	return [
		{
			unitId: createUnitId(spec.procedureSpecId, 0),
			index: 0,
			unitKind: "point",
			positionRef: "current",
			actions: plan.perPoint,
			limits: spec.limits,
			resumeKey: createResumeKey(spec.procedureSpecId, 0),
			artifactScope: {
				artifactPathPrefix: createArtifactPrefix(spec.procedureSpecId, 0),
			},
		},
	];
}

function assertCompiledUnits(units: ExecutionUnit[]): ExecutionUnit[] {
	for (const [index, unit] of units.entries()) {
		const candidate: unknown = unit;
		if (!ExecutionUnitValidator.Check(candidate)) {
			const errors = formatValidationErrors(ExecutionUnitValidator, candidate).join("; ");
			throw new Error(`invalid execution unit at index ${index}: ${errors}`);
		}
	}
	return units;
}

export function compileProcedureSpec(spec: ProcedureSpec): ExecutionUnit[] {
	const units =
		spec.plan.kind === "point_list"
			? buildPointListUnits(spec, spec.plan)
			: spec.plan.kind === "grid_scan"
				? buildGridScanUnits(spec, spec.plan)
				: buildCurrentPositionUnit(spec, spec.plan);
	return assertCompiledUnits(units);
}
