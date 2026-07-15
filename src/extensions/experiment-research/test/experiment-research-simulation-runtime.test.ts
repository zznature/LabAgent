import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import { createRunRecords } from "../records/run-records.ts";
import { readArtifactRecords, readRunEvents } from "../store/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
	getActiveTools(): string[];
}

function createTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-exp-sim-"));
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

function loadExperimentExtension(): CapturedExtension {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, CapturedHandler[]>();
	let activeTools = ["read"];
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: CapturedHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(toolNames: string[]) {
			activeTools = toolNames;
		},
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers, getActiveTools: () => activeTools };
}

function createProcedureSpec(pointCount = 3) {
	return {
		procedureSpecId: `proc-spec-${pointCount}`,
		experimentId: "exp-sim-001",
		intentId: "intent-sim-001",
		procedureId: "raman_grid_mapping",
		procedureVersion: "0.1.0",
		resources: [
			{ resourceId: "stage-main", role: "stage" },
			{ resourceId: "frame-main", role: "frame_provider" },
			{ resourceId: "spectrometer-main", role: "spectrometer" },
		],
		limits: {
			maxLaserPowerPercent: 1,
			minObjectiveClearanceUm: 200,
		},
		plan: {
			kind: "point_list",
			points: Array.from({ length: pointCount }, (_, index) => ({
				xUm: 1000 + index * 5,
				yUm: 2000 + index * 5,
			})),
			perPoint: [
				{ kind: "move_to_point" },
				{ kind: "autofocus" },
				{ kind: "capture_frame" },
				{ kind: "acquire_spectrum" },
			],
		},
		stoppingRules: {
			maxRuntimeMinutes: 20,
			maxUnits: pointCount,
			stopOnError: true,
		},
		domain: {
			raman: {
				autofocus: {
					enabled: true,
					roi: { x: 100, y: 100, width: 64, height: 64 },
				},
				acquisition: {
					integrationTimeMs: 1000,
					laserPowerPercent: 0.1,
					accumulations: 1,
				},
			},
		},
	};
}

function createParameterSearchSpec(maxAttempts = 3) {
	return {
		procedureSpecId: `proc-search-${maxAttempts}`,
		experimentId: "exp-search-001",
		intentId: "intent-search-001",
		procedureId: "raman_parameter_search",
		procedureVersion: "0.1.0",
		resources: [
			{ resourceId: "stage-main", role: "stage" },
			{ resourceId: "frame-main", role: "frame_provider" },
			{ resourceId: "spectrometer-main", role: "spectrometer" },
		],
		limits: {
			maxLaserPowerPercent: 1,
			minObjectiveClearanceUm: 200,
		},
		plan: {
			kind: "point_list",
			points: Array.from({ length: maxAttempts }, () => ({
				xUm: 1000,
				yUm: 2000,
			})),
			perPoint: [
				{ kind: "move_to_point" },
				{ kind: "autofocus" },
				{ kind: "capture_frame" },
				{ kind: "acquire_spectrum" },
			],
		},
		stoppingRules: {
			maxRuntimeMinutes: 20,
			maxUnits: maxAttempts,
			stopOnError: true,
		},
		domain: {
			raman: {
				autofocus: {
					enabled: true,
					roi: { x: 100, y: 100, width: 64, height: 64 },
				},
				acquisition: {
					integrationTimeMs: 1500,
					laserPowerPercent: 0.1,
					accumulations: 1,
				},
				parameterSearch: {
					maxAttempts,
					laserPowerPercentValues: [0.01, 0.1, 1],
					integrationTimeMs: { min: 1000, max: 3000 },
					accumulations: [1, 2],
				},
			},
		},
	};
}

async function proposeAndStart(
	extension: CapturedExtension,
	spec: ReturnType<typeof createProcedureSpec>,
	context: ExtensionContext,
	simulation?: Record<string, unknown>,
): Promise<string> {
	const proposed = await extension.tools
		.get("propose_run")
		?.execute("propose", { spec, simulation }, undefined, undefined, context);
	const proposalState = (proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
	const proposalId = proposalState.proposalId as string;

	const started = await extension.tools
		.get("approve_and_start_run")
		?.execute("approve", { proposalId, spec, simulation }, undefined, undefined, context);
	return (started?.details as Record<string, unknown>).runId as string;
}

async function pollUntilTerminal(
	extension: CapturedExtension,
	runId: string,
	context: ExtensionContext,
	expectedStatuses: string[],
	timeoutMs = 3_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await extension.tools.get("poll_run")?.execute("poll", { runId }, undefined, undefined, context);
		const details = result?.details as Record<string, unknown> | undefined;
		const stateAfter = details?.stateAfter as Record<string, unknown> | undefined;
		const status = stateAfter?.status;
		if (stateAfter && typeof status === "string" && expectedStatuses.includes(status)) {
			return stateAfter;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`run ${runId} did not reach ${expectedStatuses.join(", ")} within timeout`);
}

describe("experiment research simulation runtime", () => {
	it("registers the simulation lifecycle tools and activates them on session start", async () => {
		const extension = loadExperimentExtension();
		const [sessionStart] = extension.handlers.get("session_start") ?? [];

		expect(extension.tools.has("propose_run")).toBe(true);
		expect(extension.tools.has("approve_and_start_run")).toBe(true);
		expect(extension.tools.has("run_procedure")).toBe(true);
		expect(extension.tools.has("poll_run")).toBe(true);
		expect(extension.tools.has("pause_run")).toBe(true);
		expect(extension.tools.has("resume_run")).toBe(true);
		expect(extension.tools.has("abort_run")).toBe(true);

		await sessionStart?.({ type: "session_start", sessionId: "test-session" }, {});
		expect(extension.getActiveTools()).toEqual(
			expect.arrayContaining([
				"read",
				"get_lab_capabilities",
				"get_lab_state",
				"propose_run",
				"approve_and_start_run",
				"poll_run",
				"pause_run",
				"abort_run",
			]),
		);
	});

	it("runs a simulation procedure to completion and persists snapshots, events, and artifact refs", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;

		const runId = await proposeAndStart(extension, createProcedureSpec(2), context, { perUnitDelayMs: 5 });

		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);
		expect(terminalState.status).toBe("completed");
		expect((terminalState.progress as Record<string, unknown>).completedUnits).toBe(2);
		expect((terminalState.artifactRefs as unknown[]).length).toBeGreaterThan(0);
		const records = createRunRecords(cwd);
		const observation = records.readRun(runId);
		expect(observation?.status).toBe("completed");
		expect(observation?.units.map((unit) => unit.status)).toEqual(["succeeded", "succeeded"]);
		expect(observation?.units.every((unit) => unit.acceptedAttemptId !== undefined)).toBe(true);
		expect(records.listArtifacts(runId).length).toBeGreaterThan(0);

		const pollResult = await extension.tools.get("poll_run")?.execute("poll-summary", { runId }, undefined, undefined, context);
		const pollText = pollResult?.content[0]?.type === "text" ? pollResult.content[0].text : "";
		expect(pollText).toContain("2/2 point units completed");

		const summaryResult = await extension.tools
			.get("summarize_run")
			?.execute("summarize", { runId }, undefined, undefined, context);
		const summaryDetails = summaryResult?.details as Record<string, unknown>;
		const summaryState = summaryDetails.stateAfter as Record<string, unknown>;
		const summary = summaryState.summary as Record<string, unknown>;
		const summaryText = summaryResult?.content[0]?.type === "text" ? summaryResult.content[0].text : "";
		expect(summaryText).toContain("2/2 point units completed");
		expect(summary.artifactCount).toBeGreaterThan(0);
		expect(summary.artifactCountsByKind).toBeTypeOf("object");
		expect(summaryState.artifactRefs).toBeUndefined();
		expect(summaryState.pointAttempts).toBeUndefined();

		const events = readRunEvents(cwd, runId);
		expect(events.map((event) => event.eventType)).toEqual(
			expect.arrayContaining(["run_started", "unit_started", "unit_completed", "run_completed"]),
		);
		expect(readArtifactRecords(cwd, runId).length).toBeGreaterThan(0);
	});

	it("supports manual pause and manual abort requests at safe unit boundaries", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;

		const pausedRunId = await proposeAndStart(extension, createProcedureSpec(4), context, { perUnitDelayMs: 30 });
		await extension.tools.get("pause_run")?.execute("pause", { runId: pausedRunId }, undefined, undefined, context);
		const pausedState = await pollUntilTerminal(extension, pausedRunId, context, ["paused"]);
		expect(pausedState.status).toBe("paused");
		const pausedObservation = createRunRecords(cwd).readRun(pausedRunId);
		await extension.tools.get("resume_run")?.execute("resume", { runId: pausedRunId }, undefined, undefined, context);
		const resumedState = await pollUntilTerminal(extension, pausedRunId, context, ["completed"]);
		const resumedObservation = createRunRecords(cwd).readRun(pausedRunId);
		expect(resumedState.runId).toBe(pausedRunId);
		expect(resumedObservation?.status).toBe("completed");
		expect(resumedObservation?.units.every((unit) => unit.acceptedAttemptId !== undefined)).toBe(true);
		expect(resumedObservation?.units[0]?.attemptCount).toBeGreaterThan(pausedObservation?.units[0]?.attemptCount ?? 0);
		const firstUnitAttempts = createRunRecords(cwd).listArtifacts(pausedRunId, { unitId: "unit-0000" })
			.map((artifact) => artifact.scope.kind === "run" ? artifact.scope.attemptId : undefined);
		expect(new Set(firstUnitAttempts)).toEqual(new Set(["attempt-0000-initial", "attempt-0001-initial"]));
		expect(resumedObservation?.units[0]?.acceptedAttemptId).toBe("attempt-0001-initial");

		const abortedRunId = await proposeAndStart(extension, createProcedureSpec(4), context, { perUnitDelayMs: 30 });
		await extension.tools.get("abort_run")?.execute("abort", { runId: abortedRunId }, undefined, undefined, context);
		const abortedState = await pollUntilTerminal(extension, abortedRunId, context, ["aborted"]);
		expect(abortedState.status).toBe("aborted");
	});

	it("treats simulated low-confidence autofocus as a quality signal while preserving hard failures", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;

		const autofocusRunId = await proposeAndStart(extension, createProcedureSpec(2), context, {
			autofocusLowConfidenceFailuresBeforeSuccessByUnit: { "0": 1 },
			perUnitDelayMs: 5,
		});
		const autofocusState = await pollUntilTerminal(extension, autofocusRunId, context, ["completed"]);
		expect(autofocusState.status).toBe("completed");
		expect(autofocusState.errorState).toBeUndefined();
		expect(autofocusState.pointAttempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pointUnitId: "unit-0000",
					phase: "initial",
					status: "failed",
					failureType: "quality",
					failureReason: "low_focus_confidence",
				}),
				expect.objectContaining({
					pointUnitId: "unit-0000",
					phase: "immediate_retry",
					status: "succeeded",
				}),
			]),
		);

		const spectrumRunId = await proposeAndStart(extension, createProcedureSpec(2), context, {
			spectrumTimeoutAtUnit: 1,
			perUnitDelayMs: 5,
		});
		const spectrumState = await pollUntilTerminal(extension, spectrumRunId, context, ["failed"]);
		expect((spectrumState.errorState as Record<string, unknown>).errorCode).toBe("spectrum_timeout");

		const operatorPauseRunId = await proposeAndStart(extension, createProcedureSpec(2), context, {
			operatorPauseAtUnit: 1,
			perUnitDelayMs: 5,
		});
		const operatorPauseState = await pollUntilTerminal(extension, operatorPauseRunId, context, ["paused"]);
		expect(operatorPauseState.pauseReason).toEqual(expect.stringContaining("Simulated operator pause"));
	});

	it("enforces bounded parameter-search attempts and pauses when explicit rules still reject the final attempt", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createParameterSearchSpec(3);

		const runId = await proposeAndStart(extension, spec, context, {
			perUnitDelayMs: 5,
			parameterSearchObservations: [
				{ autofocusConfidence: 0.4, saturated: false, snr: 4, targetPeakBaselineRatio: 0.8 },
				{ autofocusConfidence: 0.5, saturated: false, snr: 5, targetPeakBaselineRatio: 0.9 },
				{ autofocusConfidence: 0.6, saturated: false, snr: 6, targetPeakBaselineRatio: 1.0 },
			],
		});

		const terminalState = await pollUntilTerminal(extension, runId, context, ["paused"]);
		expect(terminalState.status).toBe("paused");
		expect((terminalState.progress as Record<string, unknown>).completedUnits).toBe(3);
		expect(terminalState.pauseReason).toEqual(expect.stringContaining("stop_and_request_user_decision"));

		const events = readRunEvents(cwd, runId).filter((event) => event.eventType === "unit_completed");
		expect(events).toHaveLength(3);
		const acquisitions = events.map(
			(event) => (event.payload as Record<string, unknown>).acquisition as Record<string, unknown>,
		);
		expect(acquisitions).toEqual([
			expect.objectContaining({ laserPowerPercent: 0.01, integrationTimeMs: 1000, accumulations: 1 }),
			expect.objectContaining({ laserPowerPercent: 0.1, integrationTimeMs: 2000, accumulations: 2 }),
			expect.objectContaining({ laserPowerPercent: 1, integrationTimeMs: 3000, accumulations: 2 }),
		]);
	});

	it("completes bounded parameter search early once explicit rules find acceptable conditions", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createParameterSearchSpec(4);

		const runId = await proposeAndStart(extension, spec, context, {
			perUnitDelayMs: 5,
			parameterSearchObservations: [
				{ autofocusConfidence: 0.9, saturated: false, snr: 10, targetPeakBaselineRatio: 1.5 },
				{ autofocusConfidence: 0.92, saturated: false, snr: 11, targetPeakBaselineRatio: 1.6 },
				{ autofocusConfidence: 0.2, saturated: true, snr: 1, targetPeakBaselineRatio: 0.2 },
				{ autofocusConfidence: 0.2, saturated: true, snr: 1, targetPeakBaselineRatio: 0.2 },
			],
		});

		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);
		expect(terminalState.status).toBe("completed");
		expect((terminalState.progress as Record<string, unknown>).completedUnits).toBe(2);

		const completedEvents = readRunEvents(cwd, runId).filter((event) => event.eventType === "unit_completed");
		expect(completedEvents).toHaveLength(2);
	});

	it("continues mapping past isolated failures but stops after the configured consecutive failure limit", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;

		const resilientSpec = {
			...createProcedureSpec(4),
			procedureSpecId: "proc-map-resilient",
			stoppingRules: {
				maxRuntimeMinutes: 20,
				maxUnits: 4,
				stopOnError: false,
				maxConsecutiveFailures: 3,
			},
		};
		const resilientRunId = await proposeAndStart(extension, resilientSpec, context, {
			perUnitDelayMs: 5,
			autofocusLowConfidenceFailuresBeforeSuccessByUnit: { "1": 1 },
		});
		const resilientState = await pollUntilTerminal(extension, resilientRunId, context, ["completed"]);
		expect(resilientState.status).toBe("completed");
		expect((resilientState.progress as Record<string, unknown>).completedUnits).toBe(4);
		expect((resilientState.progress as Record<string, unknown>).failedUnits).toBe(0);
		expect(resilientState.pointAttempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pointUnitId: "unit-0001",
					phase: "initial",
					status: "failed",
					failureReason: "low_focus_confidence",
				}),
				expect.objectContaining({
					pointUnitId: "unit-0001",
					phase: "immediate_retry",
					status: "succeeded",
				}),
			]),
		);
		const resilientSummaryResult = await extension.tools
			.get("summarize_run")
			?.execute("summarize-recovered", { runId: resilientRunId }, undefined, undefined, context);
		const resilientSummaryState = ((resilientSummaryResult?.details as Record<string, unknown>).stateAfter as Record<string, unknown>)
			.summary as Record<string, unknown>;
		expect(resilientSummaryState.retryStats).toEqual({
			failedAttempts: 1,
			retriedPoints: 1,
			recoveredPoints: 1,
			finalFailedPoints: 0,
		});
		expect((resilientState.artifactRefs as unknown[]).length).toBe(readArtifactRecords(cwd, resilientRunId).length);
		const retryArtifactPaths = readArtifactRecords(cwd, resilientRunId)
			.map((record) => record.artifact.path)
			.filter((path) => path.includes("unit-0001"));
		expect(retryArtifactPaths.some((path) => path.includes("unit-0001/attempts/attempt-0000-initial"))).toBe(true);
		expect(retryArtifactPaths.some((path) => path.includes("unit-0001/attempts/attempt-0001-immediate_retry"))).toBe(true);

		const failingSpec = {
			...createProcedureSpec(4),
			procedureSpecId: "proc-map-failing",
			stoppingRules: {
				maxRuntimeMinutes: 20,
				maxUnits: 4,
				stopOnError: false,
				maxConsecutiveFailures: 2,
			},
		};
		const failingRunId = await proposeAndStart(extension, failingSpec, context, {
			perUnitDelayMs: 5,
			spectrumTimeoutAtUnits: [1, 2],
		});
		const failingState = await pollUntilTerminal(extension, failingRunId, context, ["failed"]);
		expect((failingState.progress as Record<string, unknown>).failedUnits).toBe(2);
		expect((failingState.errorState as Record<string, unknown>).errorCode).toBe(
			"mapping_consecutive_failures_limit_reached",
		);
		expect(((failingState.errorState as Record<string, unknown>).payload as Record<string, unknown>).triggeringError).toEqual(
			expect.objectContaining({ errorCode: "spectrum_timeout" }),
		);
		const failingAttempts = failingState.pointAttempts as Record<string, unknown>[];
		expect(failingAttempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pointUnitId: "unit-0001",
					phase: "final_retry",
					status: "failed",
					failureType: "execution",
					failureReason: "timeout",
					finalForPoint: true,
				}),
				expect.objectContaining({
					pointUnitId: "unit-0002",
					phase: "final_retry",
					status: "failed",
					failureType: "execution",
					failureReason: "timeout",
					finalForPoint: true,
				}),
			]),
		);
	});

	it("enforces maxRuntimeMinutes at execution-unit checkpoints", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = {
			...createProcedureSpec(1),
			procedureSpecId: "proc-runtime-deadline",
			stoppingRules: {
				maxRuntimeMinutes: 0.0005,
				maxUnits: 1,
				stopOnError: false,
				maxConsecutiveFailures: 1,
			},
		};

		const runId = await proposeAndStart(extension, spec, context, { perUnitDelayMs: 40 });
		const state = await pollUntilTerminal(extension, runId, context, ["failed"]);

		expect((state.errorState as Record<string, unknown>).errorCode).toBe("run_deadline_exceeded");
		expect((state.progress as Record<string, unknown>).completedUnits).toBe(0);
	});

	it("rejects direct run execution and rejects approval if the spec changes after proposal", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createProcedureSpec(2);

		const directRun = await extension.tools
			.get("run_procedure")
			?.execute("direct-run", { spec, simulation: { perUnitDelayMs: 5 } }, undefined, undefined, context);
		expect((directRun?.details as Record<string, unknown>).errorCode).toBe("approval_required");

		const proposed = await extension.tools
			.get("propose_run")
			?.execute("propose", { spec, simulation: { perUnitDelayMs: 5 } }, undefined, undefined, context);
		const proposalId = (((proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>)
			.proposalId ?? "") as string;

		const mutatedSpec = {
			...spec,
			domain: {
				raman: {
					...spec.domain.raman,
					acquisition: {
						...spec.domain.raman.acquisition,
						laserPowerPercent: 1,
					},
				},
			},
		};

		const approval = await extension.tools
			.get("approve_and_start_run")
			?.execute(
				"approve-mutated",
				{ proposalId, spec: mutatedSpec, simulation: { perUnitDelayMs: 5 } },
				undefined,
				undefined,
				context,
			);
		expect((approval?.details as Record<string, unknown>).errorCode).toBe("proposal_spec_mismatch");
	});
});
