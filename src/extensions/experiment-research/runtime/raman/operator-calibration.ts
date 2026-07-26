import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fitFocusPlane,
	validateFocusPlaneRegion,
	type FocusPlaneAnchor,
} from "../../planner/focus-plane.ts";
import type { ArtifactRef, RunState } from "../../schemas/index.ts";
import {
	appendArtifactRecord,
	readRunStateSnapshot,
	runRoot,
	writeRunStateSnapshot,
} from "../../store/index.ts";

export interface OperatorFocusPlanePoint {
	pointId: string;
	xUm: number;
	yUm: number;
	zUm: number;
}

export interface OperatorFocusPlaneConfirmation {
	approvedBy: "user";
	approvedAt: string;
	acknowledgedCalibrationRunId: string;
	acknowledgedOperatorSuppliedXyz: true;
	acknowledgedNoHardwareMotion: true;
}

export interface OperatorFocusPlaneRegistration {
	calibrationRunId: string;
	procedureSpecId: string;
	experimentId: string;
	points: OperatorFocusPlanePoint[];
	operatorConfirmation: OperatorFocusPlaneConfirmation;
}

export interface RegisteredOperatorFocusPlane {
	artifact: ArtifactRef;
	runState: RunState;
	model: ReturnType<typeof fitFocusPlane>;
	validRegion: Array<{ anchorId: string; xUm: number; yUm: number }>;
}

export function registerOperatorFocusPlaneCalibration(
	cwd: string,
	input: OperatorFocusPlaneRegistration,
): RegisteredOperatorFocusPlane {
	if (input.operatorConfirmation.acknowledgedCalibrationRunId !== input.calibrationRunId) {
		throw new Error("Operator confirmation must acknowledge the exact calibrationRunId being registered.");
	}
	if (readRunStateSnapshot(cwd, input.calibrationRunId)) {
		throw new Error(`Calibration run ${input.calibrationRunId} already has a RunState.`);
	}
	const root = runRoot(cwd, input.calibrationRunId);
	const focusPlanePath = join(root, "focus-plane.json");
	if (existsSync(focusPlanePath)) {
		throw new Error(`Calibration artifact already exists for ${input.calibrationRunId}.`);
	}

	const pointIds = new Set(input.points.map((point) => point.pointId));
	if (input.points.length !== 3 || pointIds.size !== 3) {
		throw new Error("Operator focus-plane calibration requires exactly three unique pointId values.");
	}
	const anchors: FocusPlaneAnchor[] = input.points.map((point) => ({
		anchorId: point.pointId,
		xUm: point.xUm,
		yUm: point.yUm,
		zUm: point.zUm,
	}));
	const validRegion = validateFocusPlaneRegion(anchors).map(({ anchorId, xUm, yUm }) => ({
		anchorId,
		xUm,
		yUm,
	}));
	const model = fitFocusPlane(anchors);
	const content = `${JSON.stringify(
		{
			profile: "raman-focus-plane",
			calibrationRunId: input.calibrationRunId,
			procedureSpecId: input.procedureSpecId,
			source: {
				kind: "operator_supplied_xyz",
				operatorConfirmation: input.operatorConfirmation,
			},
			anchors,
			model,
			validRegion,
		},
		null,
		2,
	)}\n`;
	mkdirSync(root, { recursive: true });
	writeFileSync(focusPlanePath, content, { encoding: "utf-8", flag: "wx" });
	const artifact: ArtifactRef = {
		artifactId: `${input.calibrationRunId}-focus-plane`,
		kind: "raman-focus-plane",
		path: "focus-plane.json",
		label: "Operator-supplied Raman focus-plane calibration",
		metadata: {
			checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`,
			anchorCount: anchors.length,
			rmsErrorUm: model.rmsErrorUm,
			maxAbsErrorUm: model.maxAbsErrorUm,
			source: "operator_supplied_xyz",
		},
	};
	const recordedAt = input.operatorConfirmation.approvedAt;
	appendArtifactRecord(cwd, {
		runId: input.calibrationRunId,
		recordedAt,
		artifact,
	});
	const runState: RunState = {
		runId: input.calibrationRunId,
		experimentId: input.experimentId,
		procedureSpecId: input.procedureSpecId,
		status: "completed",
		progress: { completedUnits: 3, failedUnits: 0, totalUnits: 3, unitKind: "point" },
		qualityState: "completed",
		artifactRefs: [artifact],
		startedAt: recordedAt,
		updatedAt: recordedAt,
		endedAt: recordedAt,
	};
	writeRunStateSnapshot(cwd, runState);
	return { artifact, runState, model, validRegion };
}
