import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcedureSpec } from "../schemas/procedure-spec.ts";
import type { RunState } from "../schemas/run-state.ts";
import {
	appendArtifactRecord,
	appendRunEvent,
	listExperimentIntents,
	listProcedureSpecs,
	listRunStateSnapshots,
	readArtifactRecords,
	readExperimentIntent,
	readProcedureSpec,
	readRunEvents,
	readRunStateSnapshot,
	recordsRoot,
	runArtifactsPath,
	runEventsPath,
	runStatePath,
	saveExperimentIntent,
	saveFrozenProcedureSpec,
	writeRunStateSnapshot,
} from "../store/index.ts";

function createTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-exp-store-"));
}

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const path = tempRoots.pop();
		if (path) {
			rmSync(path, { recursive: true, force: true });
		}
	}
});

describe("experiment research persistence stores", () => {
	it("stores intents under experiment-scoped intent directories", () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);

		const intent = {
			intentId: "intent-001",
			experimentId: "exp-001",
			objective: "Find a safe Raman single-point starting condition.",
		};

		const stored = saveExperimentIntent(cwd, intent);

		expect(stored.path).toContain("lab-records");
		expect(stored.path).toContain("experiments");
		expect(stored.path).toContain("intents");
		expect(existsSync(stored.path)).toBe(true);
		expect(readExperimentIntent(cwd, intent.experimentId, intent.intentId)).toEqual(intent);
		expect(listExperimentIntents(cwd, intent.experimentId)).toEqual([intent]);
	});

	it("stores frozen procedure specs once and rejects overwrite", () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);

		const spec = {
			procedureSpecId: "proc-spec-001",
			experimentId: "exp-001",
			intentId: "intent-001",
			procedureId: "raman_single_point_probe",
			procedureVersion: "0.1.0",
			resources: [{ resourceId: "stage-main", role: "stage" }],
			limits: { maxLaserPowerPercent: 1 },
			plan: {
				kind: "point_list",
				points: [{ xUm: 1000, yUm: 2000 }],
				perPoint: [{ kind: "move_to_point" }, { kind: "acquire_spectrum" }],
			},
			domain: {
				raman: {
					autofocus: {
						enabled: false,
						roi: { x: 0, y: 0, width: 32, height: 32 },
					},
					acquisition: {
						integrationTimeMs: 1000,
						laserPowerPercent: 0.1,
						accumulations: 1,
					},
				},
			},
		};

		const stored = saveFrozenProcedureSpec(cwd, spec as ProcedureSpec);

		expect(existsSync(stored.path)).toBe(true);
		expect(readProcedureSpec(cwd, spec.experimentId, spec.procedureSpecId)).toEqual(spec);
		expect(listProcedureSpecs(cwd, spec.experimentId)).toEqual([spec]);
		expect(() => saveFrozenProcedureSpec(cwd, spec as ProcedureSpec)).toThrow(/record already exists/u);
	});

	it("separates run snapshots, append-only events, and append-only artifact refs", () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);

		const runState = {
			runId: "run-001",
			experimentId: "exp-001",
			procedureSpecId: "proc-spec-001",
			status: "running",
			progress: { completedUnits: 1, totalUnits: 4, unitKind: "point" },
			artifactRefs: [],
			startedAt: "2026-06-29T18:30:00.000Z",
			updatedAt: "2026-06-29T18:30:05.000Z",
		};
		const eventOne = {
			eventId: "event-001",
			runId: "run-001",
			experimentId: "exp-001",
			eventType: "run_started",
			timestamp: "2026-06-29T18:30:00.000Z",
			payload: { status: "running" },
		};
		const eventTwo = {
			eventId: "event-002",
			runId: "run-001",
			experimentId: "exp-001",
			eventType: "unit_completed",
			timestamp: "2026-06-29T18:30:05.000Z",
			payload: { completedUnits: 1 },
		};
		const artifactRecord = {
			runId: "run-001",
			recordedAt: "2026-06-29T18:30:06.000Z",
			artifact: {
				artifactId: "artifact-001",
				kind: "spectrum",
				path: "records/run-001/spectrum-001.txt",
			},
		};

		const storedRun = writeRunStateSnapshot(cwd, runState as RunState);
		const eventLogPath = appendRunEvent(cwd, eventOne);
		appendRunEvent(cwd, eventTwo);
		const artifactLogPath = appendArtifactRecord(cwd, artifactRecord);

		expect(storedRun.path).toBe(runStatePath(cwd, runState.runId));
		expect(eventLogPath).toBe(runEventsPath(cwd, runState.runId));
		expect(artifactLogPath).toBe(runArtifactsPath(cwd, runState.runId));
		expect(storedRun.path).not.toBe(eventLogPath);
		expect(storedRun.path).not.toBe(artifactLogPath);
		expect(eventLogPath).not.toBe(artifactLogPath);

		expect(readRunStateSnapshot(cwd, runState.runId)).toEqual(runState);
		expect(readRunEvents(cwd, runState.runId)).toEqual([eventOne, eventTwo]);
		expect(readArtifactRecords(cwd, runState.runId)).toEqual([artifactRecord]);
		expect(listRunStateSnapshots(cwd, "exp-001")).toEqual([runState]);
		expect(recordsRoot(cwd)).toContain("lab-records");
	});
});
