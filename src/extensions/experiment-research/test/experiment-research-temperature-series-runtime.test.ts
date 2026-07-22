import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import {
	clearRamanLiveRuntime,
	registerRamanLiveRuntime,
	successActionResult,
	type RamanLiveRuntime,
} from "../runtime/raman/index.ts";
import { readArtifactRecords, readRunEvents } from "../store/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
}

interface RuntimeMetrics {
	autofocusCalls: number;
	configureCalls: number;
	spectrumCalls: number;
	stopCalls: number;
}

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const path = tempRoots.pop();
		if (path) {
			clearRamanLiveRuntime(path);
			rmSync(path, { recursive: true, force: true });
		}
	}
});

function createTempCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exp-temperature-series-"));
	tempRoots.push(cwd);
	return cwd;
}

function loadExperimentExtension(): CapturedExtension {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on() {},
		getActiveTools() {
			return ["read"];
		},
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	experimentResearchExtension(api);
	return { tools };
}

function createTemperatureSeriesSpec() {
	return {
		procedureSpecId: "proc-temperature-series",
		experimentId: "exp-temperature-series",
		intentId: "intent-temperature-series",
		procedureId: "raman_temperature_series",
		procedureVersion: "0.1.0",
		resources: [
			{ resourceId: "stage-main", role: "stage" },
			{ resourceId: "frame-main", role: "frame_provider" },
			{ resourceId: "spectrometer-main", role: "spectrometer" },
			{ resourceId: "temperature-main", role: "temperature_controller" },
		],
		limits: { maxLaserPowerPercent: 1 },
		plan: { kind: "temperature_series", targetsK: [200, 100] },
		stoppingRules: { maxRuntimeMinutes: 10, maxUnits: 2, stopOnError: false },
		domain: {
			raman: {
				autofocus: {
					enabled: false,
					roi: { x: 100, y: 100, width: 64, height: 64 },
				},
				acquisition: {
					integrationTimeMs: 1,
					laserPowerPercent: 0.1,
					accumulations: 1,
					saveFormat: "txt",
				},
			},
			temperature: {
				stability: {
					toleranceK: 0.2,
					continuousHoldS: 0,
					postStableDwellS: 0,
					pollIntervalS: 0.001,
					timeoutPerTargetS: 2,
				},
				driftPolicy: {
					maxDeltaK: 0.5,
					maxReacquisitionsPerTarget: 1,
					exhaustedAction: "continue",
				},
			},
		},
	};
}

function temperatureResource() {
	return {
		resourceId: "temperature-main",
		kind: "temperature_controller" as const,
		runtime: "raman_python" as const,
		driver: "kelvinion_mini" as const,
		config: {
			port: "COM6",
			baudrate: 115200,
			channel: "A" as const,
			controlMode: "A" as const,
			outputRange: "LOW" as const,
			defaultRampKPerMin: 2,
		},
		leasePolicy: "exclusive" as const,
		simulationAvailable: true,
		operatingRange: { minTargetK: 50, maxTargetK: 350, maxRampKPerMin: 10 },
	};
}

function createRuntime(metrics: RuntimeMetrics): RamanLiveRuntime {
	let currentTargetK = 200;
	const snapshotsByTarget = new Map<number, number[]>([
		[200, [200, 200, 200.7, 200, 200, 200.1]],
		[100, [100, 100, 100.8, 100, 100, 100.7]],
	]);
	return {
		preflight() {
			return { preflightReady: true, controlAvailable: true };
		},
		stage: {
			resource: {
				resourceId: "stage-main",
				kind: "stage",
				runtime: "raman_python",
				driver: "mc_newton_xyz",
				config: { port: "COM5", xChannel: 1, yChannel: 2, zChannel: 3, baudrate: 115200 },
				leasePolicy: "exclusive",
				simulationAvailable: true,
				limits: { xRangeUm: [0, 50_000], yRangeUm: [0, 50_000], zRangeUm: [0, 5_000] },
			},
			getPosition() {
				return successActionResult("Stage position read.", { position: { xUm: 0, yUm: 0, zUm: 250 } });
			},
			moveAbsoluteAndWait() {
				return successActionResult("Stage moved.");
			},
		},
		autofocus: {
			runSingle() {
				metrics.autofocusCalls += 1;
				return successActionResult("Autofocus completed.", { zBestUm: 250, confidence: 0.9 });
			},
		},
		frame: {
			resource: {
				resourceId: "frame-main",
				kind: "frame_provider",
				runtime: "raman_python",
				driver: "labspec_file_bridge_frame",
				config: { bridgeDir: "D:\\RamanLab\\SpecBridge", imageFormat: "tif", minCaptureIntervalMs: 400 },
				leasePolicy: "shared-read",
				simulationAvailable: false,
			},
			captureLatest() {
				return successActionResult("Frame captured.");
			},
		},
		spectrometer: {
			resource: {
				resourceId: "spectrometer-main",
				kind: "spectrometer",
				runtime: "raman_python",
				driver: "labspec_file_bridge_spectrum",
				config: {
					bridgeDir: "D:\\RamanLab\\SpecBridge",
					requestFilename: "spectrum_request.ini",
					resultFilename: "spectrum_result.ini",
				},
				leasePolicy: "exclusive",
				simulationAvailable: false,
			},
			acquireSpectrum() {
				metrics.spectrumCalls += 1;
				return successActionResult(
					"Spectrum acquired.",
					{ outputPath: `spectrum-${metrics.spectrumCalls}.txt` },
					[{
						artifactId: `spectrum-${metrics.spectrumCalls}`,
						kind: "spectrum",
						path: `spectrum-${metrics.spectrumCalls}.txt`,
					}],
				);
			},
		},
		temperature: {
			resource: temperatureResource(),
			configureTarget(action) {
				metrics.configureCalls += 1;
				currentTargetK = action.targetK;
				return successActionResult("Temperature configured.", {
					temperatureK: currentTargetK,
					setpointK: currentTargetK,
				});
			},
			readSnapshot() {
				const samples = snapshotsByTarget.get(currentTargetK) ?? [currentTargetK];
				const temperatureK = samples.shift() ?? currentTargetK;
				return successActionResult("Temperature read.", {
					temperatureK,
					setpointK: currentTargetK,
					timestamp: new Date().toISOString(),
				});
			},
			stop() {
				metrics.stopCalls += 1;
				return successActionResult("Temperature stopped.", { outputRange: "OFF" });
			},
		},
	};
}

async function pollUntilTerminal(
	extension: CapturedExtension,
	runId: string,
	context: ExtensionContext,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const polled = await extension.tools.get("poll_run")?.execute("poll", { runId }, undefined, undefined, context);
		const state = (polled?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
		if (["completed", "failed", "paused", "aborted"].includes(state.status as string)) {
			return state;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`temperature series ${runId} did not reach a terminal state`);
}

describe("experiment research temperature series runtime", () => {
	it("keeps the temperature evidence contract in simulation", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createTemperatureSeriesSpec();

		const proposed = await extension.tools.get("propose_run")?.execute("propose", { spec }, undefined, undefined, context);
		const proposalId = ((proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>).proposalId;
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve",
			{
				proposalId,
				spec,
				executionMode: "simulation",
				admission: { preflightReady: true, controlAvailable: true },
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		const terminal = await pollUntilTerminal(extension, runId, context);
		const artifacts = readArtifactRecords(cwd, runId);

		expect(terminal.status).toBe("completed");
		expect(artifacts.filter((record) => record.artifact.kind === "temperature-evidence")).toHaveLength(2);
		expect(artifacts.filter((record) => record.artifact.kind === "spectrum")).toHaveLength(2);
	});

	it("preflights the configured temperature controller and its target range", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const metrics: RuntimeMetrics = { autofocusCalls: 0, configureCalls: 0, spectrumCalls: 0, stopCalls: 0 };
		registerRamanLiveRuntime(cwd, createRuntime(metrics));
		const spec = createTemperatureSeriesSpec();

		const readyResult = await extension.tools.get("run_preflight")?.execute(
			"preflight",
			{ spec, executionMode: "live-supervised" },
			undefined,
			undefined,
			context,
		);
		const readyDetails = asRecord(readyResult?.details);
		const readyState = asRecord(readyDetails.stateAfter);
		expect(readyDetails.status).toBe("success");
		expect(asRecord(readyState.temperaturePreflight).ready).toBe(true);

		spec.plan.targetsK = [400];
		const rejectedResult = await extension.tools.get("run_preflight")?.execute(
			"preflight-unsupported",
			{ spec, executionMode: "live-supervised" },
			undefined,
			undefined,
			context,
		);
		const rejectedDetails = asRecord(rejectedResult?.details);
		const rejectedState = asRecord(rejectedDetails.stateAfter);
		expect(rejectedDetails.status).toBe("warning");
		expect(asRecord(rejectedState.temperaturePreflight).reason).toBe("temperature_target_unsupported");
	});

	it("reacquires once after excessive drift, continues after exhaustion, and never stops temperature implicitly", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const metrics: RuntimeMetrics = { autofocusCalls: 0, configureCalls: 0, spectrumCalls: 0, stopCalls: 0 };
		registerRamanLiveRuntime(cwd, createRuntime(metrics));
		const spec = createTemperatureSeriesSpec();

		const proposed = await extension.tools.get("propose_run")?.execute("propose", { spec }, undefined, undefined, context);
		const proposalId = ((proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>).proposalId;
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: { preflightReady: true, controlAvailable: true },
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		const terminal = await pollUntilTerminal(extension, runId, context);

		expect(terminal.status).toBe("completed");
		expect(terminal.qualityState).toBe("completed_with_failures");
		expect(terminal.progress).toEqual(expect.objectContaining({ completedUnits: 1, failedUnits: 1, totalUnits: 2 }));
		expect(metrics).toEqual({ autofocusCalls: 0, configureCalls: 2, spectrumCalls: 4, stopCalls: 0 });

		const artifacts = readArtifactRecords(cwd, runId);
		expect(artifacts.filter((record) => record.artifact.kind === "temperature-evidence")).toHaveLength(4);
		expect(artifacts.filter((record) => record.artifact.kind === "spectrum")).toHaveLength(4);

		const eventTypes = readRunEvents(cwd, runId).map((event) => event.eventType);
		expect(eventTypes).toEqual(expect.arrayContaining(["unit_completed", "unit_failed", "run_completed"]));
	});

	it("bounds repeated pre-spectrum tolerance failures and keeps temperature output enabled", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const metrics: RuntimeMetrics = { autofocusCalls: 0, configureCalls: 0, spectrumCalls: 0, stopCalls: 0 };
		const runtime = createRuntime(metrics);
		let snapshotCalls = 0;
		runtime.temperature!.readSnapshot = () => {
			snapshotCalls += 1;
			return successActionResult("Temperature read.", {
				temperatureK: snapshotCalls % 2 === 1 ? 200 : 201,
				setpointK: 200,
				timestamp: new Date().toISOString(),
			});
		};
		registerRamanLiveRuntime(cwd, runtime);
		const spec = createTemperatureSeriesSpec();
		spec.plan.targetsK = [200];
		spec.stoppingRules.maxUnits = 1;
		spec.domain.temperature.stability.timeoutPerTargetS = 0.02;

		const proposed = await extension.tools.get("propose_run")?.execute("propose", { spec }, undefined, undefined, context);
		const proposalId = ((proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>).proposalId;
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: { preflightReady: true, controlAvailable: true },
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		const terminal = await pollUntilTerminal(extension, runId, context);

		expect(terminal.status).toBe("failed");
		expect(asRecord(terminal.errorState).errorCode).toBe("temperature_stability_timeout");
		expect(snapshotCalls).toBeGreaterThan(2);
		expect(metrics.spectrumCalls).toBe(0);
		expect(metrics.stopCalls).toBe(0);
	});

	it.each([
		["pause_run", "paused"],
		["abort_run", "aborted"],
	] as const)("keeps temperature output enabled when %s interrupts stabilization", async (toolName, expectedStatus) => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const metrics: RuntimeMetrics = { autofocusCalls: 0, configureCalls: 0, spectrumCalls: 0, stopCalls: 0 };
		registerRamanLiveRuntime(cwd, createRuntime(metrics));
		const spec = createTemperatureSeriesSpec();
		spec.plan.targetsK = [200];
		spec.stoppingRules.maxUnits = 1;
		spec.domain.temperature.stability.continuousHoldS = 1;

		const proposed = await extension.tools.get("propose_run")?.execute("propose", { spec }, undefined, undefined, context);
		const proposalId = ((proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>).proposalId;
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: { preflightReady: true, controlAvailable: true },
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		await extension.tools.get(toolName)?.execute("interrupt", { runId }, undefined, undefined, context);
		const terminal = await pollUntilTerminal(extension, runId, context);

		expect(terminal.status).toBe(expectedStatus);
		expect(metrics.stopCalls).toBe(0);
	});
});

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected record");
	}
	return value as Record<string, unknown>;
}
