import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactRef, ExecutionUnit, RamanObservationMetrics, RunState, RuntimeError } from "../schemas/index.ts";
import { appendArtifactRecord } from "../store/artifact-store.ts";
import { createRunRecords, type ArtifactDescriptor } from "../records/run-records.ts";

export interface SimulationControls {
	perUnitDelayMs?: number;
	autofocusLowConfidenceAtUnit?: number;
	autofocusLowConfidenceAtUnits?: number[];
	autofocusLowConfidenceFailuresBeforeSuccessByUnit?: Record<string, number>;
	spectrumTimeoutAtUnit?: number;
	spectrumTimeoutAtUnits?: number[];
	spectrumTimeoutFailuresBeforeSuccessByUnit?: Record<string, number>;
	stageSettleTimeoutFailuresBeforeSuccessByUnit?: Record<string, number>;
	systemicFailureAtUnit?: number;
	operatorPauseAtUnit?: number;
	parameterSearchObservations?: RamanObservationMetrics[];
	attemptCountsByUnit?: Record<string, number>;
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

function descriptorPath(descriptor: ArtifactDescriptor): string {
	const { scope } = descriptor;
	if (scope.kind !== "run") {
		throw new Error(`simulation artifacts require run scope: ${descriptor.artifactId}`);
	}
	return `artifacts/units/${scope.unitId}/attempts/${scope.attemptId}/${descriptor.artifactId}/${descriptor.representations[0]?.path ?? ""}`;
}

function persistArtifact(cwd: string, runId: string, unit: ExecutionUnit, attemptId: string, actionIndex: number, artifact: ArtifactRef, content: string): void {
	const stagingPath = join(cwd, ".pi", "experiment-research", "simulation-staging", `${artifact.artifactId}.txt`);
	mkdirSync(dirname(stagingPath), { recursive: true });
	writeFileSync(stagingPath, content, "utf-8");
	const descriptor = createRunRecords(cwd).publishArtifact({
		artifactId: artifact.artifactId,
		scope: {
			kind: "run",
			runId,
			unitId: toSafeFileStem(unit.unitId),
			attemptId,
			actionId: `action-${String(actionIndex).padStart(4, "0")}`,
		},
		layer: "source",
		sourceArtifactIds: [],
		createdAt: new Date().toISOString(),
		representations: [{ role: "source", mediaType: "text/plain", fileName: `${artifact.kind}.txt`, sourcePath: stagingPath }],
	});
	artifact.path = descriptorPath(descriptor);
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
	attemptIndex: number,
	attemptPhase = "initial",
): ArtifactRef[] {
	const attemptId = `attempt-${String(attemptIndex).padStart(4, "0")}-${attemptPhase}`;
	const artifacts: ArtifactRef[] = [];

	for (const [actionIndex, action] of unit.actions.entries()) {
		if (action.kind === "capture_frame") {
			const artifact = createArtifactRef(runId, "", "frame", "Simulated frame capture");
			persistArtifact(cwd, runId, unit, attemptId, actionIndex, artifact, `simulated frame for ${unit.unitId}\n`);
			artifacts.push(artifact);
		}
		if (action.kind === "autofocus") {
			const artifact = createArtifactRef(runId, "", "autofocus", "Simulated autofocus trace");
			persistArtifact(cwd, runId, unit, attemptId, actionIndex, artifact, `simulated autofocus trace for ${unit.unitId}\n`);
			artifacts.push(artifact);
		}
		if (action.kind === "acquire_spectrum") {
			const artifact = createArtifactRef(runId, "", "spectrum", "Simulated spectrum");
			persistArtifact(cwd, runId, unit, attemptId, actionIndex, artifact, `simulated spectrum for ${unit.unitId}\n`);
			artifacts.push(artifact);
		}
	}

	return artifacts;
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
	controls: SimulationControls,
	currentState: RunState,
	attempt?: { attemptIndex: number; phase: "initial" | "immediate_retry" | "final_retry" },
): Promise<SimulationUnitResult> {
	await sleep(controls.perUnitDelayMs ?? DEFAULT_PER_UNIT_DELAY_MS);
	const attemptCount = nextAttemptCount(controls, unit.index);

	if (controls.operatorPauseAtUnit === unit.index) {
		return {
			status: "paused",
			reason: `Simulated operator pause requested at unit ${unit.index}.`,
			artifactRefs: [],
		};
	}

	if (controls.systemicFailureAtUnit === unit.index) {
		return {
			status: "failed",
			error: createRuntimeError(
				"unknown_python_action",
				"Unsupported Python Raman action: frame_capture_laser_off",
				false,
			),
			artifactRefs: [],
		};
	}

	if (failsBeforeSuccess(controls.stageSettleTimeoutFailuresBeforeSuccessByUnit, unit.index, attemptCount)) {
		return {
			status: "failed",
			error: createRuntimeError("stage_settle_timeout", `Simulated stage settle timeout at unit ${unit.index}.`, true),
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
			artifactRefs: createUnitArtifacts(cwd, runId, unit, attemptCount, attempt?.phase),
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

	return {
		status: "completed",
		artifactRefs: createUnitArtifacts(cwd, runId, unit, attemptCount, attempt?.phase),
		observationMetrics: controls.parameterSearchObservations?.[unit.index],
	};
}
