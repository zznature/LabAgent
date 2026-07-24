import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactRef, ExecutionUnit, ProcedureSpec, RamanObservationMetrics, RunState, RuntimeError } from "../schemas/index.ts";
import { fitFocusPlane, predictFocusZ } from "../planner/focus-plane.ts";
import { validateFocusPlaneArtifactReference } from "./raman/live-runtime.ts";
import { appendArtifactRecord } from "../store/artifact-store.ts";
import { runRoot } from "../store/layout.ts";

export interface SimulationControls {
	perUnitDelayMs?: number;
	autofocusLowConfidenceAtUnit?: number;
	autofocusLowConfidenceAtUnits?: number[];
	autofocusLowConfidenceFailuresBeforeSuccessByUnit?: Record<string, number>;
	spectrumTimeoutAtUnit?: number;
	spectrumTimeoutAtUnits?: number[];
	spectrumTimeoutFailuresBeforeSuccessByUnit?: Record<string, number>;
	operatorPauseAtUnit?: number;
	parameterSearchObservations?: RamanObservationMetrics[];
	attemptCountsByUnit?: Record<string, number>;
	focusPlane?: { a: number; b: number; c: number };
}

export interface SimulationUnitSuccess {
	status: "completed";
	artifactRefs: ArtifactRef[];
	observationMetrics?: RamanObservationMetrics;
}

export interface SimulationUnitPause {
	status: "paused";
	reason: string;
	artifactRefs: ArtifactRef[];
}

export interface SimulationUnitFailure {
	status: "failed";
	error: RuntimeError;
	artifactRefs: ArtifactRef[];
}

export type SimulationUnitResult = SimulationUnitSuccess | SimulationUnitPause | SimulationUnitFailure;

const DEFAULT_PER_UNIT_DELAY_MS = 10;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createArtifactRef(runId: string, fileName: string, kind: string, label: string): ArtifactRef {
	return {
		artifactId: `${runId}-${kind}-${randomUUID().slice(0, 8)}`,
		kind,
		path: fileName.replace(/\\/g, "/"),
		label,
	};
}

function toSafeFileStem(value: string): string {
	return value.replace(/[:/\\]/gu, "-");
}

function persistArtifact(cwd: string, runId: string, artifact: ArtifactRef, content: string): void {
	const absolutePath = join(runRoot(cwd, runId), artifact.path);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content, "utf-8");
	appendArtifactRecord(cwd, {
		runId,
		recordedAt: new Date().toISOString(),
		artifact,
	});
}

function createUnitArtifacts(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	spec: ProcedureSpec,
	controls: SimulationControls,
): ArtifactRef[] {
	const prefix = `${unit.artifactScope.artifactPathPrefix}/${toSafeFileStem(unit.unitId)}`.replace(/^records\//u, "");
	const artifacts: ArtifactRef[] = [];

	for (const action of unit.actions) {
		if (action.kind === "capture_frame") {
			const artifact = createArtifactRef(runId, `${prefix}-frame.txt`, "frame", "Simulated frame capture");
			persistArtifact(cwd, runId, artifact, `simulated frame for ${unit.unitId}\n`);
			artifacts.push(artifact);
		}
		if (action.kind === "autofocus") {
			const zBestUm =
				spec.plan.kind === "focus_plane_calibration" && unit.point
					? predictFocusZ(controls.focusPlane ?? { a: 0, b: 0, c: spec.plan.seedZUm }, unit.point)
					: unit.point?.zUm;
			const artifact = createArtifactRef(runId, `${prefix}-autofocus.json`, "raman-autofocus", "Simulated autofocus result");
			persistArtifact(
				cwd,
				runId,
				artifact,
				`${JSON.stringify(
					{
						unitId: unit.unitId,
						status: "success",
						summary: "Simulated autofocus completed.",
						payload: { zBestUm, confidence: 1 },
					},
					null,
					2,
				)}\n`,
			);
			artifacts.push(artifact);
		}
		if (action.kind === "acquire_spectrum") {
			const artifact = createArtifactRef(runId, `${prefix}-spectrum.txt`, "spectrum", "Simulated spectrum");
			persistArtifact(cwd, runId, artifact, `simulated spectrum for ${unit.unitId}\n`);
			artifacts.push(artifact);
		}
	}

	return artifacts;
}

function createSimulatedFocusPlaneArtifact(
	cwd: string,
	runId: string,
	spec: ProcedureSpec,
	controls: SimulationControls,
): ArtifactRef {
	if (spec.plan.kind !== "focus_plane_calibration") {
		throw new Error("Simulated focus-plane artifact requires a calibration plan.");
	}
	const syntheticModel = controls.focusPlane ?? { a: 0, b: 0, c: spec.plan.seedZUm };
	const anchors = [spec.plan.anchors.center, ...spec.plan.anchors.corners].map((anchor) => ({
		...anchor,
		zUm: predictFocusZ(syntheticModel, anchor),
		confidence: 1,
	}));
	const model = fitFocusPlane(anchors);
	const content = `${JSON.stringify(
		{
			profile: "raman-focus-plane",
			calibrationRunId: runId,
			procedureSpecId: spec.procedureSpecId,
			anchors,
			model,
			validRegion: spec.plan.anchors.corners,
			simulated: true,
		},
		null,
		2,
	)}\n`;
	const artifact: ArtifactRef = {
		artifactId: `${runId}-focus-plane`,
		kind: "raman-focus-plane",
		path: "focus-plane.json",
		label: "Simulated Raman focus-plane calibration",
		metadata: {
			checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`,
			anchorCount: anchors.length,
		},
	};
	persistArtifact(cwd, runId, artifact, content);
	return artifact;
}

function createRuntimeError(errorCode: string, message: string, safeToResume: boolean): RuntimeError {
	return {
		errorCode,
		message,
		retrySafe: safeToResume,
		needsOperator: true,
		safeToResume,
		scope: "unit",
	};
}

function includesUnit(units: number[] | undefined, unitIndex: number): boolean {
	return units?.includes(unitIndex) ?? false;
}

function nextAttemptCount(controls: SimulationControls, unitIndex: number): number {
	const key = String(unitIndex);
	controls.attemptCountsByUnit = controls.attemptCountsByUnit ?? {};
	const attemptCount = controls.attemptCountsByUnit[key] ?? 0;
	controls.attemptCountsByUnit[key] = attemptCount + 1;
	return attemptCount;
}

function failsBeforeSuccess(config: Record<string, number> | undefined, unitIndex: number, attemptCount: number): boolean {
	const failureBudget = config?.[String(unitIndex)];
	return failureBudget !== undefined && attemptCount < failureBudget;
}

export async function runSimulationUnit(
	cwd: string,
	runId: string,
	unit: ExecutionUnit,
	spec: ProcedureSpec,
	controls: SimulationControls,
	currentState: RunState,
): Promise<SimulationUnitResult> {
	await sleep(controls.perUnitDelayMs ?? DEFAULT_PER_UNIT_DELAY_MS);
	const attemptCount = nextAttemptCount(controls, unit.index);
	const focusPlaneFailure = validateFocusPlaneArtifactReference(cwd, spec);
	if (focusPlaneFailure) {
		return {
			status: "failed",
			error: createRuntimeError(
				focusPlaneFailure.errorCode ?? "focus_plane_artifact_mismatch",
				focusPlaneFailure.summary,
				false,
			),
			artifactRefs: [],
		};
	}

	if (controls.operatorPauseAtUnit === unit.index) {
		return {
			status: "paused",
			reason: `Simulated operator pause requested at unit ${unit.index}.`,
			artifactRefs: [],
		};
	}

	if (
		controls.autofocusLowConfidenceAtUnit === unit.index ||
		includesUnit(controls.autofocusLowConfidenceAtUnits, unit.index) ||
		failsBeforeSuccess(controls.autofocusLowConfidenceFailuresBeforeSuccessByUnit, unit.index, attemptCount)
	) {
		return {
			status: "completed",
			artifactRefs: createUnitArtifacts(cwd, runId, unit, spec, controls),
			observationMetrics: {
				autofocusConfidence: 0.1,
				saturated: false,
				snr: 5,
				targetPeakBaselineRatio: 1,
			},
		};
	}

	if (
		controls.spectrumTimeoutAtUnit === unit.index ||
		includesUnit(controls.spectrumTimeoutAtUnits, unit.index) ||
		failsBeforeSuccess(controls.spectrumTimeoutFailuresBeforeSuccessByUnit, unit.index, attemptCount)
	) {
		return {
			status: "failed",
			error: createRuntimeError("spectrum_timeout", `Simulated spectrum timeout at unit ${unit.index}.`, false),
			artifactRefs: [],
		};
	}

	const artifactRefs = createUnitArtifacts(cwd, runId, unit, spec, controls);
	if (spec.procedureId === "raman_focus_plane_calibration" && unit.focusCalibration?.finalAnchor) {
		artifactRefs.push(createSimulatedFocusPlaneArtifact(cwd, runId, spec, controls));
	}
	return {
		status: "completed",
		artifactRefs,
		observationMetrics: controls.parameterSearchObservations?.[unit.index],
	};
}
