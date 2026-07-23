import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecords, recoverWorkspaceInterruptedPublications } from "../records/run-records.ts";
import { createRunRecordsReadAdapter } from "../records/read-adapter.ts";
import { runArtifactIndexPath } from "../store/layout.ts";

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const path = tempRoots.pop();
		if (path) {
			rmSync(path, { recursive: true, force: true });
		}
	}
});

function createTempCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "labagent-run-records-"));
	tempRoots.push(cwd);
	return cwd;
}

describe("Run Records Interface", () => {
	it("initializes a run observation with every execution unit", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		const snapshot = records.initializeRun({
			runId: "run-001",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [
				{ unitId: "unit-0000", index: 0, point: { row: 0, col: 0, xUm: 10, yUm: 20, zUm: 300 } },
				{ unitId: "unit-0001", index: 1, point: { row: 0, col: 1, xUm: 15, yUm: 20, zUm: 300 } },
			],
		});

		expect(snapshot).toEqual({
			schemaVersion: 1,
			runId: "run-001",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			throughSequence: 0,
			status: "queued",
			progress: { completedUnits: 0, failedUnits: 0, totalUnits: 2 },
			units: [
				{
					unitId: "unit-0000",
					index: 0,
					point: { row: 0, col: 0, xUm: 10, yUm: 20, zUm: 300 },
					status: "pending",
					attemptCount: 0,
					canonicalArtifactIds: [],
				},
				{
					unitId: "unit-0001",
					index: 1,
					point: { row: 0, col: 1, xUm: 15, yUm: 20, zUm: 300 },
					status: "pending",
					attemptCount: 0,
					canonicalArtifactIds: [],
				},
			],
			startedAt: "2026-07-15T10:00:00.000Z",
			updatedAt: "2026-07-15T10:00:00.000Z",
		});
		const backend = createRunRecordsReadAdapter(cwd);
		expect(backend.readRun("run-001")).toEqual(snapshot);
		expect(backend.readEvents("run-001", 0)).toEqual([]);
	});

	it("keeps retry attempts immutable and explicitly accepts the successful attempt", () => {
		const records = createRunRecords(createTempCwd());
		records.initializeRun({
			runId: "run-002",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-002", {
			type: "run_started",
			timestamp: "2026-07-15T10:00:01.000Z",
		});
		records.applyRunChange("run-002", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			timestamp: "2026-07-15T10:00:02.000Z",
		});
		records.applyRunChange("run-002", {
			type: "attempt_failed",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			willRetry: true,
			timestamp: "2026-07-15T10:00:03.000Z",
		});
		records.applyRunChange("run-002", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0001",
			timestamp: "2026-07-15T10:00:04.000Z",
		});
		const accepted = records.applyRunChange("run-002", {
			type: "attempt_accepted",
			unitId: "unit-0000",
			attemptId: "attempt-0001",
			canonicalArtifactIds: ["spectrum-001"],
			timestamp: "2026-07-15T10:00:05.000Z",
		});

		expect(accepted.throughSequence).toBe(5);
		expect(accepted.progress).toEqual({ completedUnits: 1, failedUnits: 0, totalUnits: 1 });
		expect(accepted.units[0]).toMatchObject({
			status: "succeeded",
			activeAttemptId: undefined,
			acceptedAttemptId: "attempt-0001",
			attemptCount: 2,
			canonicalArtifactIds: ["spectrum-001"],
		});
		expect(records.readEvents("run-002", 2).map((event) => event.sequence)).toEqual([3, 4, 5]);
		expect(records.readEvents("run-002", 2).map((event) => event.change.type)).toEqual([
			"attempt_failed",
			"attempt_started",
			"attempt_accepted",
		]);
		expect(() => records.applyRunChange("run-002", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			timestamp: "2026-07-15T10:00:06.000Z",
		})).toThrow(/attemptId was already used/u);
	});

	it("projects heartbeat and terminal errors through the observation interface", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-observation-health",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-observation-health", {
			type: "heartbeat_updated",
			timestamp: "2026-07-15T10:00:01.000Z",
		});
		const failure = {
			errorCode: "live_runtime_error",
			message: "Raman runtime stopped responding.",
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
			scope: "run" as const,
		};
		const failed = records.applyRunChange("run-observation-health", {
			type: "run_failed",
			timestamp: "2026-07-15T10:00:02.000Z",
			error: failure,
		});

		expect(failed).toMatchObject({
			status: "failed",
			heartbeatAt: "2026-07-15T10:00:01.000Z",
			errorState: failure,
			throughSequence: 2,
		});
		expect(createRunRecordsReadAdapter(cwd).readEvents("run-observation-health", 0).map((event) => event.change.type))
			.toEqual(["heartbeat_updated", "run_failed"]);
	});

	it("publishes an immutable artifact with indexed SHA-256 representations", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-003",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-003", { type: "attempt_started", unitId: "unit-0000", attemptId: "attempt-0000", timestamp: "2026-07-15T10:00:01.000Z" });
		const sourcePath = join(cwd, "bridge-spectrum.txt");
		writeFileSync(sourcePath, "1,2\n", "utf-8");

		const descriptor = records.publishArtifact({
			artifactId: "source-spectrum-001",
			scope: {
				kind: "run",
				runId: "run-003",
				unitId: "unit-0000",
				attemptId: "attempt-0000",
				actionId: "action-0003",
			},
			layer: "source",
			profile: undefined,
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:02.000Z",
			representations: [
				{
					role: "source",
					mediaType: "text/plain",
					fileName: "spectrum.txt",
					sourcePath,
				},
			],
		});

		expect(descriptor).toMatchObject({
			schemaVersion: 1,
			artifactId: "source-spectrum-001",
			layer: "source",
			status: "complete",
			representations: [
				{
					role: "source",
					mediaType: "text/plain",
					path: "representations/spectrum.txt",
					byteSize: 4,
					checksum: {
						algorithm: "sha256",
						digest: "52186c933993da4082b3cdc7c40bb4bf735b391ff54a2ef78c037dda6c38a680",
					},
				},
			],
		});
		expect(records.listArtifacts("run-003")).toEqual([descriptor]);
		expect(records.listArtifacts("run-003", { layer: "canonical" })).toEqual([]);
		expect(records.readArtifact("run-003", "source-spectrum-001")).toEqual(descriptor);
		const representation = records.readRepresentation("run-003", "source-spectrum-001", "source");
		expect(representation.mediaType).toBe("text/plain");
		expect(representation.bytes.toString("utf-8")).toBe("1,2\n");
		writeFileSync(join(cwd, "lab-records", "runs", "run-003", "artifacts", "units", "unit-0000", "attempts", "attempt-0000", "source-spectrum-001", "representations", "spectrum.txt"), "corrupt\n");
		expect(() => records.readRepresentation("run-003", "source-spectrum-001", "source")).toThrow(/checksum mismatch/u);
		expect(records.readEvents("run-003", 0).flatMap((event) =>
			event.change.type === "artifact_status_changed" ? [event.change.status] : [],
		)).toEqual(["pending", "producing", "complete"]);
		expect(records.readRun("run-003")?.throughSequence).toBe(4);
		expect(() => records.publishArtifact({
		artifactId: "wrong-unit-artifact",
		scope: { kind: "run", runId: "run-003", unitId: "unit-9999", attemptId: "attempt-0000", actionId: "action-0001" },
		layer: "source",
		sourceArtifactIds: [],
		createdAt: "2026-07-15T10:00:03.000Z",
		representations: [{ role: "source", mediaType: "text/plain", fileName: "source.txt", sourcePath }],
	})).toThrow(/run observation unit not found/u);
	});

	it("keeps publishing and reading artifacts when the rebuildable index cannot be written", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-degraded-index",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-degraded-index", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			timestamp: "2026-07-15T10:00:01.000Z",
		});
		const sourcePath = join(cwd, "source-spectrum.txt");
		writeFileSync(sourcePath, "100\t12\n200\t18\n", "utf-8");

		const source = records.publishArtifact({
			artifactId: "source-spectrum",
			scope: {
				kind: "run",
				runId: "run-degraded-index",
				unitId: "unit-0000",
				attemptId: "attempt-0000",
				actionId: "action-spectrum",
			},
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:02.000Z",
			representations: [{
				role: "source",
				mediaType: "text/plain",
				fileName: "spectrum.txt",
				sourcePath,
			}],
		});
		rmSync(runArtifactIndexPath(cwd, "run-degraded-index"));
		mkdirSync(runArtifactIndexPath(cwd, "run-degraded-index"), { recursive: true });
		const canonical = records.publishArtifact({
			artifactId: "canonical-spectrum",
			scope: {
				kind: "run",
				runId: "run-degraded-index",
				unitId: "unit-0000",
				attemptId: "attempt-0000",
				actionId: "action-spectrum",
			},
			layer: "canonical",
			profile: "raman-spectrum",
			sourceArtifactIds: [source.artifactId],
			createdAt: "2026-07-15T10:00:03.000Z",
			canonicalData: {
				schemaVersion: 1,
				xAxis: { kind: "raman_shift", unit: "cm^-1", values: [100, 200] },
				yAxis: { kind: "intensity", unit: "counts", values: [12, 18] },
				acquisition: {},
				metrics: {},
			},
		});

		expect(source.status).toBe("complete");
		expect(canonical.status).toBe("complete");
		expect(records.readRun("run-degraded-index")).toMatchObject({
			status: "queued",
			artifactIndex: {
				status: "degraded",
				errorCode: "artifact_index_update_failed",
			},
		});
		expect(records.listArtifacts("run-degraded-index").map((artifact) => artifact.artifactId)).toEqual([
			"source-spectrum",
			"canonical-spectrum",
		]);
		expect(records.readRepresentation("run-degraded-index", "canonical-spectrum", "data").bytes.length).toBeGreaterThan(0);
		records.applyRunChange("run-degraded-index", {
			type: "attempt_accepted",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			canonicalArtifactIds: [canonical.artifactId],
			timestamp: "2026-07-15T10:00:04.000Z",
		});
		records.applyRunChange("run-degraded-index", {
			type: "run_completed",
			timestamp: "2026-07-15T10:00:05.000Z",
		});

		const restartedRecords = createRunRecords(cwd);
		expect(restartedRecords.recoverInterruptedPublications("run-degraded-index")).toEqual([]);
		expect(restartedRecords.readRun("run-degraded-index")).toMatchObject({
			status: "completed",
			units: [{
				status: "succeeded",
				attemptCount: 1,
				acceptedAttemptId: "attempt-0000",
				canonicalArtifactIds: ["canonical-spectrum"],
			}],
		});
		expect(restartedRecords.listArtifacts("run-degraded-index").map((artifact) => ({
			artifactId: artifact.artifactId,
			status: artifact.status,
		}))).toEqual([
			{ artifactId: "source-spectrum", status: "complete" },
			{ artifactId: "canonical-spectrum", status: "complete" },
		]);
	});

	it("rebuilds unreadable and stale artifact indexes from durable descriptors", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-rebuilt-index",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-rebuilt-index", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			timestamp: "2026-07-15T10:00:01.000Z",
		});
		const scope = {
			kind: "run" as const,
			runId: "run-rebuilt-index",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			actionId: "action-diagnostic",
		};
		records.publishArtifact({
			artifactId: "diagnostic-before-rebuild",
			scope,
			layer: "diagnostic",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:02.000Z",
			representations: [{
				role: "diagnostic",
				mediaType: "text/plain",
				fileName: "before.txt",
				content: "before\n",
			}],
		});
		writeFileSync(runArtifactIndexPath(cwd, "run-rebuilt-index"), "{", "utf-8");

		records.publishArtifact({
			artifactId: "diagnostic-after-rebuild",
			scope,
			layer: "diagnostic",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:03.000Z",
			representations: [{
				role: "diagnostic",
				mediaType: "text/plain",
				fileName: "after.txt",
				content: "after\n",
			}],
		});
		const staleIndex = readFileSync(runArtifactIndexPath(cwd, "run-rebuilt-index"), "utf-8");
		records.publishArtifact({
			artifactId: "diagnostic-after-stale-index",
			scope,
			layer: "diagnostic",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:04.000Z",
			representations: [{
				role: "diagnostic",
				mediaType: "text/plain",
				fileName: "stale.txt",
				content: "stale\n",
			}],
		});
		writeFileSync(runArtifactIndexPath(cwd, "run-rebuilt-index"), staleIndex, "utf-8");

		const restartedRecords = createRunRecords(cwd);
		expect(restartedRecords.recoverInterruptedPublications("run-rebuilt-index")).toEqual([]);
		expect(restartedRecords.listArtifacts("run-rebuilt-index").map((artifact) => artifact.artifactId)).toEqual([
			"diagnostic-before-rebuild",
			"diagnostic-after-rebuild",
			"diagnostic-after-stale-index",
		]);
		expect(restartedRecords.readRun("run-rebuilt-index")?.artifactIndex).toBeUndefined();
	});

	it("fails artifact publication closed when a source representation is missing", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-004",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-004", { type: "attempt_started", unitId: "unit-0000", attemptId: "attempt-0000", timestamp: "2026-07-15T10:00:01.000Z" });

		const descriptor = records.publishArtifact({
			artifactId: "missing-source-001",
			scope: {
				kind: "run",
				runId: "run-004",
				unitId: "unit-0000",
				attemptId: "attempt-0000",
				actionId: "action-0001",
			},
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:02.000Z",
			representations: [
				{
					role: "data",
					mediaType: "application/json",
					fileName: "spectrum.json",
					sourcePath: join(cwd, "does-not-exist.json"),
				},
			],
		});

		expect(descriptor).toMatchObject({
			artifactId: "missing-source-001",
			status: "failed",
			error: { errorCode: "artifact_source_missing" },
			representations: [],
		});
		expect(records.listArtifacts("run-004")).toEqual([descriptor]);
		expect(() => records.readRepresentation("run-004", "missing-source-001", "data")).toThrow(
			/artifact is not complete/u,
		);
	});

	it("fails a Raman frame that does not provide the fixed PNG and WebP representations", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-frame-invalid",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-frame-invalid", { type: "attempt_started", unitId: "unit-0000", attemptId: "attempt-0000", timestamp: "2026-07-15T10:00:01.000Z" });
		const frameSourcePath = join(cwd, "frame-source.tif");
		writeFileSync(frameSourcePath, "source");
		records.publishArtifact({
			artifactId: "source-frame",
			scope: { kind: "run", runId: "run-frame-invalid", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-frame" },
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:01.500Z",
			representations: [{ role: "source", mediaType: "image/tiff", fileName: "source.tif", sourcePath: frameSourcePath }],
		});
		const descriptor = records.publishArtifact({
			artifactId: "frame-invalid",
			scope: { kind: "run", runId: "run-frame-invalid", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-frame" },
			layer: "canonical",
			profile: "raman-frame",
			sourceArtifactIds: ["source-frame"],
			createdAt: "2026-07-15T10:00:01.000Z",
			representations: [{ role: "display", mediaType: "image/jpeg", fileName: "frame.jpg", content: "jpeg" }],
		});
		expect(descriptor).toMatchObject({ status: "failed", error: { errorCode: "artifact_publication_failed" } });
	});

	it("fails canonical frame and autofocus publication when required evidence is absent", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-profile-evidence",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-profile-evidence", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			timestamp: "2026-07-15T10:00:01.000Z",
		});
		const sourcePath = join(cwd, "source-frame.tif");
		writeFileSync(sourcePath, "source");
		records.publishArtifact({
			artifactId: "source-frame",
			scope: { kind: "run", runId: "run-profile-evidence", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-frame" },
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:01.500Z",
			representations: [{ role: "source", mediaType: "image/tiff", fileName: "source.tif", sourcePath }],
		});

		const frame = records.publishArtifact({
			artifactId: "canonical-frame-without-capture-time",
			scope: { kind: "run", runId: "run-profile-evidence", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-frame" },
			layer: "canonical",
			profile: "raman-frame",
			sourceArtifactIds: ["source-frame"],
			createdAt: "2026-07-15T10:00:02.000Z",
			descriptorData: { width: 512, height: 512, sourceBitDepth: 16, colorModel: "grayscale", laserState: "unknown" },
			representations: [
				{ role: "display", mediaType: "image/png", fileName: "frame.png", content: "png" },
				{ role: "thumbnail", mediaType: "image/webp", fileName: "thumbnail.webp", content: "webp" },
			],
		});
		expect(frame).toMatchObject({ status: "failed", error: { errorCode: "artifact_publication_failed" } });

		const autofocus = records.publishArtifact({
			artifactId: "canonical-autofocus-without-frame-links",
			scope: { kind: "run", runId: "run-profile-evidence", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-autofocus" },
			layer: "canonical",
			profile: "raman-autofocus",
			sourceArtifactIds: ["source-frame"],
			createdAt: "2026-07-15T10:00:03.000Z",
			canonicalData: {
				schemaVersion: 1,
				algorithmVersion: "fixed-range-autofocus-v1",
				scanPoints: [],
				peakEstimate: {},
				selectedFocus: {},
				finalVerification: {},
				parameters: {},
				frameArtifactIds: { preFocus: null, acceptedFocus: null },
			},
		});
		expect(autofocus).toMatchObject({ status: "failed", error: { errorCode: "artifact_publication_failed" } });
	});

	it("reconciles a publication interrupted before indexing as failed", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-interrupted",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-interrupted", {
			type: "attempt_started",
			unitId: "unit-0000",
			attemptId: "attempt-0000",
			timestamp: "2026-07-15T10:00:01.000Z",
		});
		const stagingRoot = join(cwd, "lab-records", "runs", "run-interrupted", "artifacts", "units", "unit-0000", "attempts", "attempt-0000", "artifact-interrupted.staging");
		mkdirSync(stagingRoot, { recursive: true });
		writeFileSync(join(stagingRoot, "publication.json"), JSON.stringify({
			schemaVersion: 1,
			artifactId: "artifact-interrupted",
			scope: { kind: "run", runId: "run-interrupted", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-0001" },
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:02.000Z",
		}), { encoding: "utf-8", flag: "w" });

		const recovered = recoverWorkspaceInterruptedPublications(cwd);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({
			artifactId: "artifact-interrupted",
			status: "failed",
			error: { errorCode: "publication_interrupted" },
		});
		expect(records.listArtifacts("run-interrupted")).toEqual(recovered);
	});

	it("normalizes Raman spectrum data into fixed JSON and CSV representations", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-005",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-005", { type: "attempt_started", unitId: "unit-0000", attemptId: "attempt-0000", timestamp: "2026-07-15T10:00:01.000Z" });
		const spectrumSourcePath = join(cwd, "spectrum-source.txt");
		writeFileSync(spectrumSourcePath, "100 12\n200 18\n");
		records.publishArtifact({
			artifactId: "source-spectrum-001",
			scope: { kind: "run", runId: "run-005", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-0003" },
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:01.500Z",
			representations: [{ role: "source", mediaType: "text/plain", fileName: "source.txt", sourcePath: spectrumSourcePath }],
		});

		const descriptor = records.publishArtifact({
			artifactId: "canonical-spectrum-001",
			scope: {
				kind: "run",
				runId: "run-005",
				unitId: "unit-0000",
				attemptId: "attempt-0000",
				actionId: "action-0003",
			},
			layer: "canonical",
			profile: "raman-spectrum",
			sourceArtifactIds: ["source-spectrum-001"],
			createdAt: "2026-07-15T10:00:02.000Z",
			canonicalData: {
				schemaVersion: 1,
				xAxis: { kind: "raman_shift", unit: "cm^-1", values: [100, 200] },
				yAxis: { kind: "intensity", unit: "counts", values: [12, 18] },
				acquisition: { integrationTimeMs: 1000, laserPowerPercent: 0.1, accumulations: 1 },
				metrics: { snr: 9.5 },
			},
		});

		expect(descriptor.status).toBe("complete");
		expect(descriptor.representations.map((representation) => representation.role)).toEqual(["data", "download"]);
		const json = JSON.parse(records.readRepresentation("run-005", descriptor.artifactId, "data").bytes.toString("utf-8")) as {
			xAxis: { unit: string };
		};
		expect(json.xAxis.unit).toBe("cm^-1");
		expect(records.readRepresentation("run-005", descriptor.artifactId, "download").bytes.toString("utf-8")).toBe(
			"raman_shift_cm-1,intensity_counts\n100,12\n200,18\n",
		);
	});

	it("publishes deterministic Raman evaluation evidence as canonical JSON", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		records.initializeRun({
			runId: "run-006",
			experimentId: "experiment-001",
			procedureSpecId: "spec-001",
			startedAt: "2026-07-15T10:00:00.000Z",
			units: [{ unitId: "unit-0000", index: 0 }],
		});
		records.applyRunChange("run-006", { type: "attempt_started", unitId: "unit-0000", attemptId: "attempt-0000", timestamp: "2026-07-15T10:00:01.000Z" });
		const evaluationSourcePath = join(cwd, "evaluation-source.json");
		writeFileSync(evaluationSourcePath, "{}\n");
		records.publishArtifact({
			artifactId: "canonical-spectrum-001",
			scope: { kind: "run", runId: "run-006", unitId: "unit-0000", attemptId: "attempt-0000", actionId: "action-spectrum" },
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:01.500Z",
			representations: [{ role: "source", mediaType: "application/json", fileName: "source.json", sourcePath: evaluationSourcePath }],
		});

		const descriptor = records.publishArtifact({
			artifactId: "evaluation-001",
			scope: {
				kind: "run",
				runId: "run-006",
				unitId: "unit-0000",
				attemptId: "attempt-0000",
				actionId: "action-evaluation",
			},
			layer: "canonical",
			profile: "raman-evaluation",
			sourceArtifactIds: ["canonical-spectrum-001"],
			createdAt: "2026-07-15T10:00:02.000Z",
			canonicalData: {
				schemaVersion: 1,
				ruleSet: { id: "raman-good-enough", version: "1" },
				inputs: { artifactIds: ["canonical-spectrum-001"], metrics: { snr: 9.5 } },
				thresholds: { snrMin: 8 },
				rules: [{ ruleId: "snr-min", actual: 9.5, operator: ">=", expected: 8, passed: true }],
				decision: "acceptable",
				reasons: [],
			},
		});

		expect(descriptor.status).toBe("complete");
		expect(descriptor.representations.map((representation) => representation.role)).toEqual(["data"]);
		const data = JSON.parse(records.readRepresentation("run-006", descriptor.artifactId, "data").bytes.toString("utf-8")) as {
			decision: string;
		};
		expect(data.decision).toBe("acceptable");
	});

	it("keeps operator operation artifacts outside every run scope", () => {
		const cwd = createTempCwd();
		const records = createRunRecords(cwd);
		const sourcePath = join(cwd, "operator-frame.tif");
		writeFileSync(sourcePath, "operator frame\n", "utf-8");
		records.initializeOperatorOperation({
			operationId: "operation-001",
			operationKind: "raman_capture_frame",
			relatedRunId: "run-previous",
			startedAt: "2026-07-15T10:00:00.000Z",
		});

		const descriptor = records.publishArtifact({
			artifactId: "operator-source-frame-001",
			scope: {
				kind: "operator",
				operationId: "operation-001",
				relatedRunId: "run-previous",
				actionId: "action-frame",
			},
			layer: "source",
			sourceArtifactIds: [],
			createdAt: "2026-07-15T10:00:01.000Z",
			representations: [
				{ role: "source", mediaType: "image/tiff", fileName: "frame.tif", sourcePath },
			],
		});

		expect(descriptor.scope).toMatchObject({ kind: "operator", operationId: "operation-001" });
		expect(records.listOperatorArtifacts("operation-001")).toEqual([descriptor]);
		expect(records.readOperatorArtifact("operation-001", descriptor.artifactId)).toEqual(descriptor);
		expect(records.readOperatorRepresentation("operation-001", descriptor.artifactId, "source").bytes.toString("utf-8")).toBe(
			"operator frame\n",
		);
		expect(records.listArtifacts("run-previous")).toEqual([]);
	});
});
