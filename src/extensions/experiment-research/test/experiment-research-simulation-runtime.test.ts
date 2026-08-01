import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import { pollRun, startLiveRamanRun } from "../kernel/run-controller.ts";
import { buildProcedureSpec } from "../planner/procedure-spec-builder.ts";
import type { ProcedureSpec, RunState } from "../schemas/index.ts";
import { readArtifactRecords, readRunEvents, writeRunStateSnapshot } from "../store/index.ts";
import { registerRamanLiveRuntime, successActionResult, type RamanLiveRuntime } from "../runtime/raman/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedMessage {
	customType: string;
	content: string;
	details?: unknown;
}

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
	messages: CapturedMessage[];
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
	const messages: CapturedMessage[] = [];
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
		sendMessage(message: CapturedMessage) {
			messages.push(message);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(toolNames: string[]) {
			activeTools = toolNames;
		},
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers, messages, getActiveTools: () => activeTools };
}

function createProcedureSpec(pointCount = 3): ProcedureSpec {
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
				zUm: 1500,
			})),
			surfaceCorrection: { kind: "disabled", reason: "user_declined" },
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

function createParameterSearchSpec(maxAttempts = 3): ProcedureSpec {
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
	spec: ProcedureSpec,
	context: ExtensionContext,
	simulation?: Record<string, unknown>,
): Promise<string> {
	const proposed = await extension.tools
		.get("propose_run")
		?.execute("propose", { spec, simulation }, undefined, undefined, context);
	const proposalState = (proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
	const proposalId = proposalState.proposalId as string;
	const specHash = proposalState.specHash as string;

	const started = await extension.tools
		.get("approve_and_start_run")
		?.execute("approve", { proposalId, specHash, simulation }, undefined, undefined, context);
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

async function waitForRunStatus(cwd: string, runId: string, expectedStatuses: string[], timeoutMs = 3_000): Promise<RunState> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const runState = pollRun(cwd, runId);
		if (runState && expectedStatuses.includes(runState.status)) {
			return runState;
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
		expect(extension.tools.has("revise_proposal")).toBe(true);
		expect(extension.tools.has("abort_run")).toBe(true);

		await sessionStart?.({ type: "session_start", sessionId: "test-session" }, {});
		expect(extension.getActiveTools()).toEqual(
			expect.arrayContaining([
				"read",
				"get_lab_capabilities",
				"get_lab_state",
				"propose_run",
				"revise_proposal",
				"approve_and_start_run",
				"poll_run",
				"pause_run",
				"resume_run",
				"abort_run",
			]),
		);
	});

	it("returns the specHash to approve in the propose_run result text", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;

		const proposed = await extension.tools
			.get("propose_run")
			?.execute("propose-hash", { spec: createProcedureSpec(1) }, undefined, undefined, context);
		const proposalState = (proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
		const text = proposed?.content[0]?.type === "text" ? proposed.content[0].text : "";

		// The operator approves by specHash, so the agent must be able to quote it without an external lookup.
		expect(text).toContain(`Run proposal ${proposalState.proposalId as string} created`);
		expect(text).toContain(`specHash=${proposalState.specHash as string}`);
	});

	it("surfaces run and point failure causes in run summary text and in not-active errors", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const baseRunState: RunState = {
			runId: "run-diagnostics-001",
			experimentId: "exp-diagnostics-001",
			procedureSpecId: "proc-diagnostics-001",
			status: "failed",
			progress: { completedUnits: 1, failedUnits: 1, totalUnits: 6, unitKind: "point" },
			currentUnit: { unitId: "proc-diagnostics-001:unit:0001", index: 1 },
			errorState: {
				errorCode: "stage_move_failed",
				message: "Stage did not settle within 120000 ms (delta x=-775.341; tolerance x=5.000)",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
				scope: "unit",
			},
			artifactRefs: [],
			startedAt: "2026-07-24T21:00:00.000Z",
			updatedAt: "2026-07-24T21:02:00.000Z",
		};
		writeRunStateSnapshot(cwd, baseRunState);

		const failedSummary = await extension.tools
			.get("summarize_run")
			?.execute("summarize-failed", { runId: baseRunState.runId }, undefined, undefined, context);
		const failedText = failedSummary?.content[0]?.type === "text" ? failedSummary.content[0].text : "";
		expect(failedText).toContain("Run failure stage_move_failed: Stage did not settle within 120000 ms");

		const pauseResult = await extension.tools
			.get("pause_run")
			?.execute("pause-failed", { runId: baseRunState.runId }, undefined, undefined, context);
		const pauseDetails = pauseResult?.details as Record<string, unknown>;
		const pauseText = pauseResult?.content[0]?.type === "text" ? pauseResult.content[0].text : "";
		expect(pauseDetails.errorCode).toBe("run_not_active");
		expect(pauseText).toContain("current status is failed");
		expect(pauseText).toContain("stage_move_failed");

		// A run that keeps going after point failures has no errorState; the latest attempt carries the cause.
		writeRunStateSnapshot(cwd, {
			...baseRunState,
			status: "running",
			errorState: undefined,
			pointAttempts: [
				{
					pointUnitId: "proc-diagnostics-001:unit:0001",
					attemptId: "proc-diagnostics-001:unit:0001:initial:0",
					attemptIndex: 0,
					phase: "initial",
					status: "failed",
					failureType: "execution",
					failureReason: "timeout",
					errorCode: "stage_move_failed",
					message: "Stage did not settle within 120000 ms",
					timestamp: "2026-07-24T21:01:00.000Z",
				},
			],
		});

		const runningSummary = await extension.tools
			.get("summarize_run")
			?.execute("summarize-running", { runId: baseRunState.runId }, undefined, undefined, context);
		const runningText = runningSummary?.content[0]?.type === "text" ? runningSummary.content[0].text : "";
		expect(runningText).toContain("Latest point failure on proc-diagnostics-001:unit:0001 (initial attempt 0)");
		expect(runningText).toContain("stage_move_failed/timeout: Stage did not settle within 120000 ms");
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

		const events = readRunEvents(cwd, runId);
		expect(events.map((event) => event.eventType)).toEqual(
			expect.arrayContaining(["run_started", "unit_started", "unit_completed", "run_completed"]),
		);
		expect(readArtifactRecords(cwd, runId).length).toBeGreaterThan(0);
	});

	it("records the last accepted focus z in run state and exposes it through lab state and run summary", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		let position = { xUm: 100, yUm: 200, zUm: 1_666.336 };
		const runtime = {
			preflight: () => ({ preflightReady: true, controlAvailable: true }),
			stage: {
				resource: {
					resourceId: "stage-main",
					kind: "stage",
					runtime: "raman_python",
					driver: "memory",
					config: { port: "memory", xChannel: 1, yChannel: 2, zChannel: 3, baudrate: 115_200 },
					leasePolicy: "exclusive",
					simulationAvailable: true,
					limits: { xRangeUm: [0, 5_000], yRangeUm: [0, 5_000], zRangeUm: [0, 5_000] },
				},
				getPosition: () => successActionResult("position", { position }),
				moveAbsoluteAndWait: (action: { target: { xUm: number; yUm: number; zUm?: number } }) => {
					position = {
						xUm: action.target.xUm,
						yUm: action.target.yUm,
						zUm: action.target.zUm ?? position.zUm,
					};
					return successActionResult("moved", { position });
				},
			},
			autofocus: {
				runSingle: () => {
					const zBestUm = 1683.005;
					position = { ...position, zUm: zBestUm };
					return successActionResult("focused", {
						zBestUm,
						confidence: 0.9,
						quality: "good",
					});
				},
			},
			frame: {
				resource: {
					resourceId: "frame-main",
					kind: "frame_provider",
					runtime: "raman_python",
					driver: "memory",
					config: { bridgeDir: "memory", imageFormat: "tif", minCaptureIntervalMs: 0 },
					leasePolicy: "shared-read",
					simulationAvailable: true,
				},
				captureLatest: () => successActionResult("frame"),
			},
			spectrometer: {
				resource: {
					resourceId: "spectrometer-main",
					kind: "spectrometer",
					runtime: "raman_python",
					driver: "memory",
					config: { bridgeDir: "memory", requestFilename: "request", resultFilename: "result" },
					leasePolicy: "exclusive",
					simulationAvailable: true,
				},
				acquireSpectrum: () =>
					successActionResult("spectrum", {
						saturated: false,
						snr: 20,
						targetPeakBaselineRatio: 5,
					}),
			},
		} as unknown as RamanLiveRuntime;
		registerRamanLiveRuntime(cwd, runtime);

		const spec = buildProcedureSpec({
			procedureId: "raman_single_point_probe",
			intent: {
				intentId: "intent-focus-context",
				experimentId: "experiment-focus-context",
				objective: "Confirm focus context propagation.",
			},
			resources: {
				stageResourceId: "stage-main",
				frameProviderResourceId: "frame-main",
				spectrometerResourceId: "spectrometer-main",
			},
			limits: {
				maxLaserPowerPercent: 1,
				minObjectiveClearanceUm: 0,
				xRangeUm: { minUm: 0, maxUm: 5_000 },
				yRangeUm: { minUm: 0, maxUm: 5_000 },
				zRangeUm: { minUm: 0, maxUm: 5_000 },
			},
			autofocus: {
				enabled: true,
				roi: { x: 100, y: 100, width: 64, height: 64 },
				params: {
					zStartUm: 1636.1075,
					zEndUm: 1696.1075,
					pointCount: 10,
					framesPerZ: 1,
					finalVerificationFramesPerZ: 1,
				},
			},
			acquisition: {
				integrationTimeMs: 1_000,
				laserPowerPercent: 0.1,
				accumulations: 1,
			},
			point: { xUm: 100, yUm: 200, zUm: 1_666.336 },
		});

		const runState = startLiveRamanRun(cwd, spec);
		const completedState = await waitForRunStatus(cwd, runState.runId, ["completed"]);
		expect(completedState.lastAcceptedFocusZUm).toBeCloseTo(1683.005);
		expect(completedState.focusCenterPolicy).toBe("previous_successful_then_current_point");

		const summaryResult = await extension.tools
			.get("summarize_run")
			?.execute("summarize-focus-context", { runId: runState.runId }, undefined, undefined, context);
		const summaryDetails = summaryResult?.details as Record<string, unknown>;
		const summaryState = summaryDetails.stateAfter as Record<string, unknown>;
		expect(summaryState.lastAcceptedFocusZUm).toBeCloseTo(1683.005);
		expect(summaryState.focusCenterPolicy).toBe("previous_successful_then_current_point");

		const labState = await extension.tools
			.get("get_lab_state")
			?.execute("lab-state", {}, undefined, undefined, context);
		const labDetails = labState?.details as Record<string, unknown>;
		const labStateAfter = labDetails.stateAfter as Record<string, unknown>;
		expect(labStateAfter.focusCenterPolicy).toBe("previous_successful_then_current_point");
	});

	it("publishes one immutable focus-plane artifact after a separate calibration run", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = buildProcedureSpec({
			procedureId: "raman_focus_plane_calibration",
			intent: {
				intentId: "intent-calibration",
				experimentId: "experiment-calibration",
				objective: "Calibrate sample focus plane.",
			},
			resources: {
				stageResourceId: "stage-main",
				frameProviderResourceId: "frame-main",
				spectrometerResourceId: "spectrometer-main",
			},
			limits: {
				xRangeUm: { minUm: 0, maxUm: 5_000 },
				yRangeUm: { minUm: 0, maxUm: 5_000 },
				zRangeUm: { minUm: 0, maxUm: 5_000 },
			},
			autofocus: {
				enabled: true,
				roi: { x: 0, y: 0, width: 64, height: 64 },
			},
			acquisition: {
				integrationTimeMs: 100,
				laserPowerPercent: 0,
				accumulations: 1,
			},
			currentPosition: { xUm: 2_000, yUm: 2_000, zUm: 1_000 },
			maxXySpanUm: 500,
		});

		const runId = await proposeAndStart(extension, spec, context, {
			perUnitDelayMs: 0,
			focusPlane: { a: 0.01, b: -0.02, c: 1_000 },
		});
		await pollUntilTerminal(extension, runId, context, ["completed"]);

		const artifacts = readArtifactRecords(cwd, runId).filter(
			(record) => record.artifact.kind === "raman-focus-plane",
		);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]?.artifact.metadata?.checksum).toMatch(/^sha256:/u);
	});

	it("waits between repeated points when interPointDelayMs is set", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createProcedureSpec(2);
		if (spec.plan.kind !== "point_list") {
			throw new Error("test spec must use point_list");
		}
		spec.plan.interPointDelayMs = 30;

		const startedAt = Date.now();
		const runId = await proposeAndStart(extension, spec, context, { perUnitDelayMs: 1 });
		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
		expect(terminalState.status).toBe("completed");
		expect(readRunEvents(cwd, runId).map((event) => event.eventType)).toContain("inter_unit_delay_started");
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
					pointUnitId: "proc-spec-2:unit:0000",
					phase: "initial",
					status: "failed",
					failureType: "quality",
					failureReason: "low_focus_confidence",
				}),
				expect.objectContaining({
					pointUnitId: "proc-spec-2:unit:0000",
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
					pointUnitId: "proc-map-resilient:unit:0001",
					phase: "initial",
					status: "failed",
					failureReason: "low_focus_confidence",
				}),
				expect.objectContaining({
					pointUnitId: "proc-map-resilient:unit:0001",
					phase: "immediate_retry",
					status: "succeeded",
				}),
			]),
		);

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
		const failingAttempts = failingState.pointAttempts as Record<string, unknown>[];
		expect(failingAttempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					pointUnitId: "proc-map-failing:unit:0001",
					phase: "final_retry",
					status: "failed",
					failureType: "execution",
					failureReason: "timeout",
					finalForPoint: true,
				}),
				expect.objectContaining({
					pointUnitId: "proc-map-failing:unit:0002",
					phase: "final_retry",
					status: "failed",
					failureType: "execution",
					failureReason: "timeout",
					finalForPoint: true,
				}),
			]),
		);
	});

	it("rejects direct run execution and rejects approval that quotes a different specHash", async () => {
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

		const approval = await extension.tools
			.get("approve_and_start_run")
			?.execute(
				"approve-stale-hash",
				{ proposalId, specHash: "sha256-of-some-other-spec", simulation: { perUnitDelayMs: 5 } },
				undefined,
				undefined,
				context,
			);
		expect((approval?.details as Record<string, unknown>).errorCode).toBe("proposal_spec_mismatch");
	});

	it("resumes a paused run from the paused unit without repeating completed units", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const [sessionStart] = extension.handlers.get("session_start") ?? [];
		await sessionStart?.({ type: "session_start", sessionId: "resume-session" }, { cwd });
		const context = { cwd } as ExtensionContext;

		const runId = await proposeAndStart(extension, createProcedureSpec(4), context, {
			operatorPauseAtUnit: 2,
			perUnitDelayMs: 5,
		});
		const paused = await pollUntilTerminal(extension, runId, context, ["paused"]);
		expect((paused.progress as Record<string, unknown>).completedUnits).toBe(2);
		expect((paused.currentUnit as Record<string, unknown>).index).toBe(2);

		// The terminal push carries the reason and the next step, so nobody has to poll for it.
		const pausedMessage = extension.messages.at(-1);
		expect(pausedMessage?.customType).toBe("run_terminal");
		expect(pausedMessage?.content).toContain("Call resume_run");

		const preview = await extension.tools
			.get("resume_run")
			?.execute("resume-preview", { runId }, undefined, undefined, context);
		const previewText = preview?.content[0]?.type === "text" ? preview.content[0].text : "";
		expect((preview?.details as Record<string, unknown>).status).toBe("warning");
		expect(previewText).toContain("unit 2");
		expect(previewText).toContain("2 units are already completed");

		const resumed = await extension.tools
			.get("resume_run")
			?.execute("resume", { runId, confirmed: true }, undefined, undefined, context);
		expect((resumed?.details as Record<string, unknown>).status).toBe("success");

		const completed = await pollUntilTerminal(extension, runId, context, ["completed"]);
		expect((completed.progress as Record<string, unknown>).completedUnits).toBe(4);

		// Completed units are never repeated; the paused unit itself did not finish, so it reruns.
		const startedUnits = readRunEvents(cwd, runId)
			.filter((event) => event.eventType === "unit_started")
			.map((event) => (event.payload as Record<string, unknown>).index);
		expect(startedUnits).toEqual([0, 1, 2, 2, 3]);
	});

	it("refuses to resume a run that is not paused", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;

		const missing = await extension.tools
			.get("resume_run")
			?.execute("resume-missing", { runId: "sim-run-nonexistent" }, undefined, undefined, context);
		expect((missing?.details as Record<string, unknown>).errorCode).toBe("run_not_found");

		const runId = await proposeAndStart(extension, createProcedureSpec(1), context, { perUnitDelayMs: 5 });
		await pollUntilTerminal(extension, runId, context, ["completed"]);
		const completedResume = await extension.tools
			.get("resume_run")
			?.execute("resume-completed", { runId }, undefined, undefined, context);
		const completedText = completedResume?.content[0]?.type === "text" ? completedResume.content[0].text : "";
		expect((completedResume?.details as Record<string, unknown>).errorCode).toBe("run_not_paused");
		expect(completedText).toContain("current status is completed");
	});

	it("revises a pending proposal with a merge patch and supersedes the original", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createProcedureSpec(2);

		const proposed = await extension.tools
			.get("propose_run")
			?.execute("propose", { spec }, undefined, undefined, context);
		const proposalState = (proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
		const proposalId = proposalState.proposalId as string;

		const revised = await extension.tools.get("revise_proposal")?.execute(
			"revise",
			{
				proposalId,
				patch: { domain: { raman: { acquisition: { integrationTimeMs: 4000 } } } },
				reason: "operator asked for a longer integration time",
			},
			undefined,
			undefined,
			context,
		);
		const revisedState = (revised?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
		const revisedText = revised?.content[0]?.type === "text" ? revised.content[0].text : "";
		expect(revisedState.revisionOf).toBe(proposalId);
		expect(revisedState.specHash).not.toBe(proposalState.specHash);
		expect(revisedText).toContain("does not carry over");

		// The superseded proposal can no longer be approved, and the revision keeps the patched value.
		const staleApproval = await extension.tools
			.get("approve_and_start_run")
			?.execute(
				"approve-superseded",
				{ proposalId, specHash: proposalState.specHash as string },
				undefined,
				undefined,
				context,
			);
		expect((staleApproval?.details as Record<string, unknown>).errorCode).toBe("proposal_not_pending");

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-revised",
			{
				proposalId: revisedState.proposalId as string,
				specHash: revisedState.specHash as string,
				simulation: { perUnitDelayMs: 5 },
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		await pollUntilTerminal(extension, runId, context, ["completed"]);
		const acquisitionEvent = readRunEvents(cwd, runId).find((event) => event.eventType === "unit_completed");
		expect(acquisitionEvent).toBeDefined();
	});

	it("expands a point_list line generator server-side", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createProcedureSpec(1);
		const lineSpec: ProcedureSpec = {
			...spec,
			procedureSpecId: "proc-spec-line",
			plan: {
				kind: "point_list",
				generator: { kind: "line", from: { xUm: 0, yUm: 0, zUm: 1500 }, to: { xUm: 100, yUm: 0, zUm: 1500 }, count: 5 },
				surfaceCorrection: { kind: "disabled", reason: "user_declined" },
				perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			},
			stoppingRules: { maxRuntimeMinutes: 20, maxUnits: 5, stopOnError: true },
		};

		const runId = await proposeAndStart(extension, lineSpec, context, { perUnitDelayMs: 1 });
		const completed = await pollUntilTerminal(extension, runId, context, ["completed"]);
		expect((completed.progress as Record<string, unknown>).completedUnits).toBe(5);
		expect(compileProcedureSpec(lineSpec).map((unit) => unit.point?.xUm)).toEqual([0, 25, 50, 75, 100]);

		const inset: ProcedureSpec = {
			...lineSpec,
			procedureSpecId: "proc-spec-line-inset",
			plan: { ...lineSpec.plan, generator: { kind: "line", from: { xUm: 0, yUm: 0, zUm: 1500 }, to: { xUm: 100, yUm: 0, zUm: 1500 }, count: 3, insetUm: 10 } },
		} as ProcedureSpec;
		expect(compileProcedureSpec(inset).map((unit) => unit.point?.xUm)).toEqual([10, 50, 90]);
	});
});
