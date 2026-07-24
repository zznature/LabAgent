import type {
	ExecutionUnit,
	ExecutionUnitPoint,
} from "../schemas/execution-unit.ts";
import { ExecutionUnitValidator } from "../schemas/execution-unit.ts";
import {
	focusPlaneCenter,
	isPointInConvexRegion,
	predictFocusZ,
	validateFocusPlaneCorners,
} from "../planner/focus-plane.ts";
import type {
	CurrentPositionPlan,
	FocusPlaneCalibrationPlan,
	GridScanPlan,
	Point,
	PointListPlan,
	ProcedureSpec,
} from "../schemas/procedure-spec.ts";
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
		interUnitDelayMs: index < plan.points.length - 1 ? plan.interPointDelayMs : undefined,
		resumeKey: createResumeKey(spec.procedureSpecId, index),
		artifactScope: {
			artifactPathPrefix: createArtifactPrefix(spec.procedureSpecId, index),
		},
	}));
}

function buildGridPoints(plan: GridScanPlan): ExecutionUnitPoint[] {
	if (plan.surfaceCorrection?.kind === "disabled" && plan.grid.origin.zUm === undefined) {
		throw new Error("Uncorrected mapping requires an explicit fixed grid origin zUm.");
	}
	const points: ExecutionUnitPoint[] = [];
	for (let row = 0; row < plan.grid.rows; row++) {
		const columns = Array.from({ length: plan.grid.cols }, (_, column) => column);
		if (plan.grid.order === "snake" && row % 2 === 1) {
			columns.reverse();
		}
		for (const col of columns) {
			const point = {
				row,
				col,
				xUm: plan.grid.origin.xUm + col * plan.grid.pitchXUm,
				yUm: plan.grid.origin.yUm + row * plan.grid.pitchYUm,
				zUm: plan.grid.origin.zUm,
			};
			if (plan.surfaceCorrection?.kind === "focus_plane") {
				if (!isPointInConvexRegion(point, plan.surfaceCorrection.validRegion)) {
					throw new Error(`Mapping point row=${row}, col=${col} is outside the approved focus-plane region.`);
				}
				point.zUm = predictFocusZ(plan.surfaceCorrection.coefficients, point);
			}
			points.push(point);
		}
	}
	return points;
}

function buildFocusPlaneCalibrationUnits(spec: ProcedureSpec, plan: FocusPlaneCalibrationPlan): ExecutionUnit[] {
	validateFocusPlaneCorners(plan.anchors.corners);
	const expectedCornerIds = ["corner_1", "corner_2", "corner_3", "corner_4"];
	if (plan.anchors.corners.some((corner, index) => corner.anchorId !== expectedCornerIds[index])) {
		throw new Error("Focus-plane corner identities must be ordered exactly as corner_1 through corner_4.");
	}
	const moveIndexes = plan.perPoint.flatMap((action, index) => (action.kind === "move_to_point" ? [index] : []));
	const autofocusIndexes = plan.perPoint.flatMap((action, index) => (action.kind === "autofocus" ? [index] : []));
	if (
		moveIndexes.length !== 1 ||
		autofocusIndexes.length !== 1 ||
		moveIndexes[0]! >= autofocusIndexes[0]!
	) {
		throw new Error("Focus-plane calibration requires exactly one move_to_point followed by exactly one autofocus action.");
	}
	const derivedCenter = focusPlaneCenter(plan.anchors.corners);
	if (
		Math.abs(derivedCenter.xUm - plan.anchors.center.xUm) > 1e-9 ||
		Math.abs(derivedCenter.yUm - plan.anchors.center.yUm) > 1e-9
	) {
		throw new Error("Focus-plane center must be the arithmetic mean of the four approved corners.");
	}
	const targets = [plan.anchors.center, ...plan.anchors.corners];
	const samples: Array<{
		point: Point;
		sampleRole: "anchor" | "waypoint";
		anchorId?: string;
		finalAnchor?: boolean;
	}> = [];
	let previous = plan.startPosition;
	if (
		Math.abs(previous.xUm - plan.anchors.center.xUm) > 1e-9 ||
		Math.abs(previous.yUm - plan.anchors.center.yUm) > 1e-9
	) {
		samples.push({
			point: { xUm: previous.xUm, yUm: previous.yUm, zUm: plan.seedZUm },
			sampleRole: "waypoint",
		});
	}
	for (const [targetIndex, target] of targets.entries()) {
		const dx = target.xUm - previous.xUm;
		const dy = target.yUm - previous.yUm;
		const segmentCount = Math.max(1, Math.ceil(Math.hypot(dx, dy) / plan.maxXySpanUm));
		for (let segment = 1; segment <= segmentCount; segment++) {
			const isTarget = segment === segmentCount;
			samples.push({
				point: {
					xUm: previous.xUm + (dx * segment) / segmentCount,
					yUm: previous.yUm + (dy * segment) / segmentCount,
					zUm: plan.seedZUm,
				},
				sampleRole: isTarget ? "anchor" : "waypoint",
				anchorId: isTarget ? target.anchorId : undefined,
				finalAnchor: isTarget && targetIndex === targets.length - 1 ? true : undefined,
			});
		}
		previous = target;
	}
	return samples.map((sample, index) => ({
		unitId: createUnitId(spec.procedureSpecId, index),
		index,
		unitKind: "point",
		positionRef: "absolute",
		point: toExecutionPoint(sample.point),
		actions: plan.perPoint,
		limits: spec.limits,
		resumeKey: createResumeKey(spec.procedureSpecId, index),
		artifactScope: {
			artifactPathPrefix: createArtifactPrefix(spec.procedureSpecId, index),
		},
		focusCalibration: {
			sampleRole: sample.sampleRole,
			anchorId: sample.anchorId,
			finalAnchor: sample.finalAnchor,
		},
	}));
}

function buildGridScanUnits(spec: ProcedureSpec, plan: GridScanPlan): ExecutionUnit[] {
	if (plan.surfaceCorrection?.kind === "focus_plane") {
		const moveIndexes = plan.perPoint.flatMap((action, index) => (action.kind === "move_to_point" ? [index] : []));
		const autofocusIndexes = plan.perPoint.flatMap((action, index) => (action.kind === "autofocus" ? [index] : []));
		const acquisitionIndexes = plan.perPoint.flatMap((action, index) => (action.kind === "acquire_spectrum" ? [index] : []));
		if (
			moveIndexes.length !== 1 ||
			autofocusIndexes.length !== 1 ||
			acquisitionIndexes.length !== 1 ||
			moveIndexes[0]! >= autofocusIndexes[0]! ||
			autofocusIndexes[0]! >= acquisitionIndexes[0]!
		) {
			throw new Error(
				"Focus-plane mapping requires exactly one move_to_point, then one autofocus, then one acquire_spectrum action.",
			);
		}
	}
	const points = buildGridPoints(plan);
	return points.map((point, index) => ({
		unitId: createUnitId(spec.procedureSpecId, index),
		index,
		unitKind: "point",
		positionRef: "absolute",
		point,
		actions: plan.perPoint,
		limits: spec.limits,
		interUnitDelayMs: index < points.length - 1 ? plan.interPointDelayMs : undefined,
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

function assertAutofocusWindowsWithinSpecLimits(spec: ProcedureSpec, units: ExecutionUnit[]): void {
	const zRange = spec.limits.zRangeUm;
	if (!zRange) {
		return;
	}
	const surfaceCorrection =
		spec.plan.kind === "grid_scan" && spec.plan.surfaceCorrection?.kind === "focus_plane"
			? spec.plan.surfaceCorrection
			: undefined;
	const windows =
		spec.plan.kind === "focus_plane_calibration"
			? [{ unitId: units[0]?.unitId ?? spec.procedureSpecId, minimum: spec.plan.seedZUm - 100, maximum: spec.plan.seedZUm + 100 }]
			: surfaceCorrection
				? units.map((unit) => ({
						unitId: unit.unitId,
						minimum: unit.point!.zUm! - surfaceCorrection.localAutofocusHalfRangeUm,
						maximum: unit.point!.zUm! + surfaceCorrection.localAutofocusHalfRangeUm,
					}))
				: [];
	for (const window of windows) {
		if (window.minimum < zRange.minUm || window.maximum > zRange.maxUm) {
			throw new Error(
				`Autofocus window [${window.minimum}, ${window.maximum}] um for ${window.unitId} exceeds the approved Z range.`,
			);
		}
	}
}

export function compileProcedureSpec(spec: ProcedureSpec): ExecutionUnit[] {
	const units =
		spec.plan.kind === "point_list"
			? buildPointListUnits(spec, spec.plan)
			: spec.plan.kind === "grid_scan"
				? buildGridScanUnits(spec, spec.plan)
				: spec.plan.kind === "focus_plane_calibration"
					? buildFocusPlaneCalibrationUnits(spec, spec.plan)
					: buildCurrentPositionUnit(spec, spec.plan);
	if (
		spec.plan.kind === "focus_plane_calibration" &&
		spec.stoppingRules?.maxUnits !== undefined &&
		spec.stoppingRules.maxUnits < units.length
	) {
		throw new Error(
			`Focus-plane calibration requires all ${units.length} compiled units; stoppingRules.maxUnits cannot truncate the model-producing run.`,
		);
	}
	assertAutofocusWindowsWithinSpecLimits(spec, units);
	return assertCompiledUnits(units);
}
