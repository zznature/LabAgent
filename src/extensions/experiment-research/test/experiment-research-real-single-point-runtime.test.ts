import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import { validateExecutionContract } from "../kernel/validate-execution.ts";
import type { ProcedureSpec } from "../schemas/index.ts";
import {
	clearRamanLiveRuntime,
	failedActionResult,
	type RamanLiveRuntime,
	registerRamanLiveRuntime,
	successActionResult,
} from "../runtime/raman/index.ts";
import { readArtifactRecords, readRunEvents } from "../store/index.ts";
import { createRunRecords } from "../records/run-records.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
}

let specSequence = 0;

function createTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-exp-live-"));
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

function loadExperimentExtension(): CapturedExtension {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, CapturedHandler[]>();
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
			return ["read"];
		},
		setActiveTools() {},
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers };
}

function createSinglePointSpec(overrides?: {
	laserPowerPercent?: number;
	pointZUm?: number;
	currentPosition?: boolean;
	procedureId?: "raman_single_point_probe" | "raman_parameter_search" | "raman_grid_mapping";
	maxAttempts?: number;
}): {
	procedureSpecId: string;
	experimentId: string;
	intentId: string;
	procedureId: "raman_single_point_probe" | "raman_parameter_search" | "raman_grid_mapping";
	procedureVersion: string;
	resources: Array<{ resourceId: string; role: string }>;
	limits: Record<string, unknown>;
	plan: Record<string, unknown>;
	stoppingRules: Record<string, unknown>;
	domain: Record<string, unknown>;
} {
	specSequence += 1;
	const suffix = String(specSequence).padStart(3, "0");
	return {
		procedureSpecId: `proc-live-single-${suffix}`,
		experimentId: "exp-live-001",
		intentId: "intent-live-001",
		procedureId: overrides?.procedureId ?? "raman_single_point_probe",
		procedureVersion: "0.1.0",
		resources: [
			{ resourceId: "stage-main", role: "stage" },
			{ resourceId: "frame-main", role: "frame_provider" },
			{ resourceId: "spectrometer-main", role: "spectrometer" },
		],
		limits: {
			maxLaserPowerPercent: 1,
			minObjectiveClearanceUm: 200,
			xRangeUm: { minUm: 0, maxUm: 50_000 },
			yRangeUm: { minUm: 0, maxUm: 50_000 },
			zRangeUm: { minUm: 0, maxUm: 5_000 },
		},
		plan: {
			...(overrides?.currentPosition
				? { kind: "current_position" }
				: {
						kind: "point_list",
						points: Array.from(
							{ length: overrides?.procedureId === "raman_parameter_search" ? (overrides.maxAttempts ?? 3) : 1 },
							() => ({
								xUm: 1000,
								yUm: 2000,
								zUm: overrides?.pointZUm ?? 250,
							}),
						),
					}),
			perPoint: [
				{ kind: "move_to_point" },
				{ kind: "autofocus" },
				{ kind: "capture_frame" },
				{ kind: "acquire_spectrum" },
			],
		},
		stoppingRules: {
			maxRuntimeMinutes: 20,
			maxUnits: overrides?.procedureId === "raman_parameter_search" ? (overrides.maxAttempts ?? 3) : 1,
			stopOnError: true,
		},
		domain: {
			raman: {
				autofocus: {
					enabled: true,
					roi: { x: 100, y: 100, width: 64, height: 64 },
					params: {
						zStartUm: 220,
						zEndUm: 300,
						pointCount: 10,
						framesPerZ: 1,
						warmupFramesPerZ: 1,
					},
				},
				acquisition: {
					integrationTimeMs: 1000,
					laserPowerPercent: overrides?.laserPowerPercent ?? 0.1,
					accumulations: 1,
					saveFormat: "txt",
				},
				...(overrides?.procedureId === "raman_parameter_search"
					? {
							parameterSearch: {
								maxAttempts: overrides.maxAttempts ?? 3,
								laserPowerPercentValues: [0.01, 0.1, 1],
								integrationTimeMs: { min: 1000, max: 3000 },
								accumulations: [1, 2],
							},
						}
					: {}),
			},
		},
	};
}

function createLiveRuntime(
	preflightReady = true,
	controlAvailable = true,
	observations?: Array<{ saturated: boolean; snr: number; targetPeakBaselineRatio: number }>,
	metrics?: { stageMoveCalls: number },
	autofocusConfidences?: number[],
	artifactRoot?: string,
): RamanLiveRuntime {
	let spectrumCall = 0;
	let autofocusCall = 0;
	function artifactPath(fileName: string, fallback: string): string {
		if (!artifactRoot) {
			return fallback;
		}
		mkdirSync(artifactRoot, { recursive: true });
		const path = join(artifactRoot, fileName);
		writeFileSync(path, `${fileName}\n`, "utf-8");
		return path;
	}
	const autofocusCurvePath = artifactPath("autofocus-curve.json", "artifacts/live/autofocus-curve.json");
	const preFocusFramePath = artifactPath("autofocus-pre-focus.tif", "artifacts/live/autofocus-pre-focus.tif");
	const preFocusDisplayPath = artifactPath("autofocus-pre-focus.png", "artifacts/live/autofocus-pre-focus.png");
	const preFocusThumbnailPath = artifactPath("autofocus-pre-focus.webp", "artifacts/live/autofocus-pre-focus.webp");
	const acceptedFocusFramePath = artifactPath("autofocus-accepted-focus.tif", "artifacts/live/autofocus-accepted-focus.tif");
	const acceptedFocusDisplayPath = artifactPath("autofocus-accepted-focus.png", "artifacts/live/autofocus-accepted-focus.png");
	const acceptedFocusThumbnailPath = artifactPath("autofocus-accepted-focus.webp", "artifacts/live/autofocus-accepted-focus.webp");
	const framePath = artifactPath("frame.tif", "artifacts/live/frame.tif");
	const canonicalDisplayPath = artifactPath("frame.png", "artifacts/live/frame.png");
	const canonicalThumbnailPath = artifactPath("thumbnail.webp", "artifacts/live/thumbnail.webp");
	const spectrumPath = artifactPath("spectrum.txt", "artifacts/live/spectrum.txt");
	return {
		preflight() {
			return {
				preflightReady,
				controlAvailable,
				details: {
					stageConnected: preflightReady,
					controlLease: controlAvailable ? "held" : "missing",
				},
			};
		},
		stage: {
			resource: {
				resourceId: "stage-main",
				kind: "stage",
				runtime: "raman_python",
				driver: "mc_newton_xyz",
				config: {
					port: "COM5",
					xChannel: 1,
					yChannel: 2,
					zChannel: 3,
					baudrate: 115200,
				},
				leasePolicy: "exclusive",
				simulationAvailable: true,
				limits: {
					xRangeUm: [0, 50_000],
					yRangeUm: [0, 50_000],
					zRangeUm: [0, 5_000],
				},
			},
			getPosition() {
				return successActionResult("Stage position read.", {
					position: { xUm: 1000, yUm: 2000, zUm: 250 },
				});
			},
			moveAbsoluteAndWait(action) {
				if (metrics) {
					metrics.stageMoveCalls += 1;
				}
				return successActionResult("Stage moved.", {
					finalPosition: action.target,
				});
			},
		},
		autofocus: {
			runSingle() {
				const confidence = autofocusConfidences?.[Math.min(autofocusCall, autofocusConfidences.length - 1)] ?? 0.96;
				autofocusCall += 1;
				return successActionResult(
					"Autofocus completed.",
					{
						zBestUm: 260,
						confidence,
						finalScore: 1.4,
						autofocusFrames: {
							preFocus: {
								sourcePath: preFocusFramePath,
								canonicalDisplayPath: preFocusDisplayPath,
								canonicalThumbnailPath: preFocusThumbnailPath,
								capturedAt: "2026-07-15T10:00:01.000Z",
								width: 512,
								height: 512,
								bitDepth: 16,
								colorModel: "grayscale",
								laserStateVerified: "unknown",
							},
							acceptedFocus: {
								sourcePath: acceptedFocusFramePath,
								canonicalDisplayPath: acceptedFocusDisplayPath,
								canonicalThumbnailPath: acceptedFocusThumbnailPath,
								capturedAt: "2026-07-15T10:00:02.000Z",
								width: 512,
								height: 512,
								bitDepth: 16,
								colorModel: "grayscale",
								laserStateVerified: "unknown",
							},
						},
					},
					[
						{
							artifactId: "autofocus-curve",
							kind: "autofocus",
							path: autofocusCurvePath,
							label: "Live autofocus curve",
						},
						{
							artifactId: "autofocus-pre-focus-frame",
							kind: "autofocus-pre-focus-frame",
							path: preFocusFramePath,
							label: "Autofocus pre-focus frame",
						},
						{
							artifactId: "autofocus-accepted-focus-frame",
							kind: "autofocus-accepted-focus-frame",
							path: acceptedFocusFramePath,
							label: "Autofocus accepted-focus frame",
						},
					],
				);
			},
		},
		frame: {
			resource: {
				resourceId: "frame-main",
				kind: "frame_provider",
				runtime: "raman_python",
				driver: "labspec_file_bridge_frame",
				config: {
					bridgeDir: "D:\\RamanLab\\SpecBridge",
					imageFormat: "tif",
					minCaptureIntervalMs: 400,
				},
				leasePolicy: "shared-read",
				simulationAvailable: false,
			},
			captureLatest() {
				return successActionResult(
					"Frame captured.",
					{
						framePath,
						canonicalDisplayPath,
						canonicalThumbnailPath,
						width: 512,
						height: 512,
						bitDepth: 16,
						colorModel: "grayscale",
						capturedAt: "2026-07-15T10:00:03.000Z",
					},
					[
						{
							artifactId: "frame-latest",
							kind: "frame",
							path: framePath,
							label: "Live frame",
						},
					],
				);
			},
			captureLaserOff() {
				return successActionResult("not used");
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
					laserPower: {
						unit: "percent",
						allowedPercentValues: [0.01, 0.1, 1, 3.2, 5, 10, 25, 50, 100],
						defaultPercent: 0.1,
						maxAllowedPercent: 100,
					},
				},
				leasePolicy: "exclusive",
				simulationAvailable: false,
			},
			acquireSpectrum() {
				const observation = observations?.[Math.min(spectrumCall, observations.length - 1)];
				spectrumCall += 1;
				return successActionResult(
					"Spectrum acquired.",
					{
						outputPath: spectrumPath,
						canonicalSpectrum: {
							xAxis: { kind: "raman_shift", unit: "cm^-1", values: [100, 200] },
							yAxis: { kind: "intensity", unit: "counts", values: [12, 18] },
						},
						saturated: observation?.saturated ?? false,
						snr: observation?.snr ?? 12,
						targetPeakBaselineRatio: observation?.targetPeakBaselineRatio ?? 1.8,
					},
					[
						{
							artifactId: "spectrum-live",
							kind: "spectrum",
							path: spectrumPath,
							label: "Live spectrum",
						},
					],
				);
			},
		},
	};
}

async function proposeRun(
	extension: CapturedExtension,
	spec: ReturnType<typeof createSinglePointSpec>,
	context: ExtensionContext,
): Promise<string> {
	const proposed = await extension.tools
		.get("propose_run")
		?.execute("propose", { spec }, undefined, undefined, context);
	const proposalState = (proposed?.details as Record<string, unknown>).stateAfter as Record<string, unknown>;
	return proposalState.proposalId as string;
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

describe("experiment research real supervised single-point runtime", () => {
	it("rejects misleading or ambiguous focus evidence roles", () => {
		const reversed = createSinglePointSpec();
		reversed.plan.perPoint = [
			{ kind: "capture_frame", role: "post_focus" },
			{ kind: "autofocus" },
			{ kind: "capture_frame", role: "pre_focus", laserState: "off" },
			{ kind: "acquire_spectrum" },
		];
		const repeatedAutofocus = createSinglePointSpec();
		repeatedAutofocus.plan.perPoint = [
			{ kind: "autofocus" },
			{ kind: "autofocus" },
			{ kind: "acquire_spectrum" },
		];

		expect(validateExecutionContract(reversed as ProcedureSpec, "live-supervised").map((issue) => issue.code))
			.toContain("invalid_focus_evidence_order");
		expect(validateExecutionContract(repeatedAutofocus as ProcedureSpec, "live-supervised").map((issue) => issue.code))
			.toContain("ambiguous_raman_action_sequence");
	});
	it("continues a repeated single-point run after a unit failure when stopOnError is false", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const runtime = createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts"));
		const runAutofocus = runtime.autofocus.runSingle.bind(runtime.autofocus);
		let autofocusCalls = 0;
		runtime.autofocus.runSingle = async (action) => {
			autofocusCalls += 1;
			if (autofocusCalls === 2) {
				return failedActionResult("Injected autofocus failure.", {
					errorCode: "autofocus_runtime_error",
					message: "Injected autofocus failure.",
					retrySafe: false,
					needsOperator: false,
					safeToResume: true,
				});
			}
			return runAutofocus(action);
		};
		registerRamanLiveRuntime(cwd, runtime);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		spec.plan.points = Array.from({ length: 3 }, () => ({ xUm: 1000, yUm: 2000, zUm: 250 }));
		spec.stoppingRules = { maxRuntimeMinutes: 20, maxUnits: 3, stopOnError: false };
		const proposalId = await proposeRun(extension, spec, context);

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-continue-on-failure",
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
		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);

		expect(autofocusCalls).toBe(3);
		expect(terminalState.progress).toEqual(expect.objectContaining({ completedUnits: 2, failedUnits: 1 }));
		expect(terminalState.qualityState).toBe("completed_with_failures");
		const observation = createRunRecords(cwd).readRun(runId);
		expect(observation?.units.map((unit) => unit.status)).toEqual(["succeeded", "failed", "succeeded"]);
	});

	it("captures distinct laser-off pre-focus and post-focus frame artifacts in one attempt", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const runtime = createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts"));
		const captureLatest = runtime.frame.captureLatest.bind(runtime.frame);
		let latestCaptureCalls = 0;
		let laserOffCaptureCalls = 0;
		runtime.frame.captureLatest = async (action) => {
			latestCaptureCalls += 1;
			return captureLatest(action);
		};
		runtime.frame.captureLaserOff = async (action) => {
			laserOffCaptureCalls += 1;
			const result = await captureLatest({ ...action, action: "frame.capture_latest" });
			return {
				...result,
				payload: { ...result.payload, laserStateVerified: "off" },
			};
		};
		registerRamanLiveRuntime(cwd, runtime);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		spec.plan.perPoint = [
			{ kind: "move_to_point" },
			{ kind: "capture_frame", role: "pre_focus", laserState: "off" },
			{ kind: "autofocus" },
			{ kind: "capture_frame", role: "post_focus", laserState: "unchanged" },
			{ kind: "acquire_spectrum" },
		];
		const proposalId = await proposeRun(extension, spec, context);

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-frame-roles",
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
		await pollUntilTerminal(extension, runId, context, ["completed"]);

		expect(laserOffCaptureCalls).toBe(1);
		expect(latestCaptureCalls).toBe(1);
		const explicitFrames = createRunRecords(cwd).listArtifacts(runId).filter(
			(artifact) => artifact.profile === "raman-frame" && !artifact.artifactId.includes("autofocus"),
		);
		expect(explicitFrames).toHaveLength(2);
		expect(new Set(explicitFrames.map((artifact) => artifact.artifactId)).size).toBe(2);
		expect(new Set(explicitFrames.map((artifact) => artifact.scope.actionId))).toEqual(
			new Set(["action-0001", "action-0003"]),
		);
		expect(explicitFrames.map((artifact) => artifact.data?.laserState)).toEqual(
			expect.arrayContaining(["off", "unknown"]),
		);
	});

	it.each([
		{ operation: "abort", toolName: "abort_run", terminalStatus: "aborted" },
		{ operation: "pause", toolName: "pause_run", terminalStatus: "paused" },
	])("stops before the next hardware action when $operation is requested during autofocus", async ({ toolName, terminalStatus }) => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const runtime = createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts"));
		const originalAutofocus = runtime.autofocus.runSingle.bind(runtime.autofocus);
		const originalFrameCapture = runtime.frame.captureLatest.bind(runtime.frame);
		const originalSpectrumAcquisition = runtime.spectrometer.acquireSpectrum.bind(runtime.spectrometer);
		let autofocusStarted!: () => void;
		let releaseAutofocus!: () => void;
		const autofocusStartedPromise = new Promise<void>((resolve) => {
			autofocusStarted = resolve;
		});
		const autofocusReleasePromise = new Promise<void>((resolve) => {
			releaseAutofocus = resolve;
		});
		let frameCaptureCalls = 0;
		let spectrumAcquisitionCalls = 0;
		runtime.autofocus.runSingle = async (action) => {
			autofocusStarted();
			await autofocusReleasePromise;
			return originalAutofocus(action);
		};
		runtime.frame.captureLatest = async (action) => {
			frameCaptureCalls += 1;
			return originalFrameCapture(action);
		};
		runtime.spectrometer.acquireSpectrum = async (action) => {
			spectrumAcquisitionCalls += 1;
			return originalSpectrumAcquisition(action);
		};
		registerRamanLiveRuntime(cwd, runtime);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		const proposalId = await proposeRun(extension, spec, context);
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			`approve-live-${toolName}-checkpoint`,
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
		await autofocusStartedPromise;
		await extension.tools.get(toolName)?.execute(`${toolName}-live`, { runId }, undefined, undefined, context);
		releaseAutofocus();

		const terminalState = await pollUntilTerminal(extension, runId, context, [terminalStatus]);
		expect(terminalState.status).toBe(terminalStatus);
		expect(frameCaptureCalls).toBe(0);
		expect(spectrumAcquisitionCalls).toBe(0);
	});

	it("fails the active attempt when required autofocus evidence is malformed", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const runtime = createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts"));
		const originalAutofocus = runtime.autofocus.runSingle.bind(runtime.autofocus);
		runtime.autofocus.runSingle = async (action) => {
			const result = await originalAutofocus(action);
			return { ...result, payload: { ...result.payload, autofocusFrames: undefined } };
		};
		registerRamanLiveRuntime(cwd, runtime);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		const proposalId = await proposeRun(extension, spec, context);
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-malformed-autofocus",
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
		await pollUntilTerminal(extension, runId, context, ["failed"]);

		const observation = createRunRecords(cwd).readRun(runId);
		expect(observation?.units[0]?.status).toBe("failed");
		expect(observation?.units[0]?.activeAttemptId).toBeUndefined();
		expect(observation?.errorState?.errorCode).toBe("live_runtime_error");
	});

	it("fails closed when a required canonical representation cannot be published", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const runtime = createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts"));
		const originalFrameCapture = runtime.frame.captureLatest.bind(runtime.frame);
		runtime.frame.captureLatest = async (action) => {
			const result = await originalFrameCapture(action);
			return {
				...result,
				payload: { ...result.payload, canonicalDisplayPath: join(cwd, "missing-canonical-frame.png") },
			};
		};
		registerRamanLiveRuntime(cwd, runtime);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		const proposalId = await proposeRun(extension, spec, context);
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-canonical-failure",
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
		const terminalState = await pollUntilTerminal(extension, runId, context, ["failed"]);

		const observation = createRunRecords(cwd).readRun(runId);
		expect(observation?.units[0]?.status).toBe("failed");
		expect(observation?.errorState?.errorCode).toBe("canonical_artifact_publication_failed");
		expect(terminalState.progress).toEqual(expect.objectContaining({ completedUnits: 0, failedUnits: 1 }));
		const recordArtifacts = createRunRecords(cwd).listArtifacts(runId, {
			unitId: "unit-0000",
			attemptId: "attempt-0000-initial",
		});
		const stateArtifactIds = new Set(
			(terminalState.artifactRefs as Array<{ artifactId: string }>).map((artifact) => artifact.artifactId),
		);
		expect(recordArtifacts.some((artifact) => artifact.status === "failed")).toBe(true);
		expect(recordArtifacts.every((artifact) => stateArtifactIds.has(artifact.artifactId))).toBe(true);
		const summary = await extension.tools.get("summarize_run")?.execute(
			"summarize-canonical-failure",
			{ runId },
			undefined,
			undefined,
			context,
		);
		expect(summary?.content[0]).toEqual(expect.objectContaining({
			text: expect.stringContaining("canonical_artifact_publication_failed"),
		}));
	});

	it("rejects live supervised approval when no live runtime is registered", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		const proposalId = await proposeRun(extension, spec, context);

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-missing-runtime",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);

		expect((started?.details as Record<string, unknown>).errorCode).toBe("live_runtime_unavailable");
	});

	it("surfaces live preflight readiness and control availability for single-point Raman runs", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		registerRamanLiveRuntime(cwd, createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts")));
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();

		const result = await extension.tools
			.get("run_preflight")
			?.execute("live-preflight", { spec, executionMode: "live-supervised" }, undefined, undefined, context);
		const details = result?.details as Record<string, unknown>;
		const state = details.stateAfter as Record<string, unknown>;

		expect(details.status).toBe("success");
		expect(state.mode).toBe("live-supervised");
		expect(state.preflightReady).toBe(true);
		expect(state.controlAvailable).toBe(true);
		expect(state.readyForApproval).toBe(true);
		expect(state.requestedModeSupported).toBe(true);
	});

	it("executes a live supervised single-point run, records artifacts, and persists rule-based evaluation output", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		registerRamanLiveRuntime(cwd, createLiveRuntime(true, true, undefined, undefined, undefined, join(cwd, "driver-artifacts")));
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec();
		const proposalId = await proposeRun(extension, spec, context);

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);
		expect((started?.details as Record<string, unknown>).status).toBe("success");
		const runId = (started?.details as Record<string, unknown>).runId as string;
		expect(runId).toBeTypeOf("string");
		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);

		expect(terminalState.status).toBe("completed");
		expect((terminalState.progress as Record<string, unknown>).completedUnits).toBe(1);

		const artifacts = readArtifactRecords(cwd, runId);
		expect(artifacts.some((record) => record.artifact.kind === "raman-evaluation")).toBe(true);
		expect(artifacts.some((record) => record.artifact.kind === "spectrum")).toBe(true);
		const formalArtifacts = createRunRecords(cwd).listArtifacts(runId);
		expect(formalArtifacts.length).toBeGreaterThan(0);
		expect(formalArtifacts.map((artifact) => artifact.profile)).toEqual(
			expect.arrayContaining(["raman-frame", "raman-autofocus", "raman-spectrum", "raman-evaluation"]),
		);
		const canonicalFrames = formalArtifacts.filter(
			(artifact) => artifact.profile === "raman-frame" && artifact.status === "complete",
		);
		expect(canonicalFrames).toHaveLength(3);
		expect(canonicalFrames.every((artifact) => typeof artifact.data?.capturedAt === "string")).toBe(true);
		const autofocus = formalArtifacts.find(
			(artifact) => artifact.profile === "raman-autofocus" && artifact.status === "complete",
		);
		expect(autofocus).toBeDefined();
		const autofocusData = JSON.parse(
			createRunRecords(cwd).readRepresentation(runId, autofocus!.artifactId, "data").bytes.toString("utf-8"),
		) as { frameArtifactIds: { preFocus: string; acceptedFocus: string } };
		expect(new Set([autofocusData.frameArtifactIds.preFocus, autofocusData.frameArtifactIds.acceptedFocus])).toEqual(
			new Set(canonicalFrames.map((artifact) => artifact.artifactId).filter((artifactId) => artifactId.includes("autofocus"))),
		);
		const observationUnit = createRunRecords(cwd).readRun(runId)?.units[0];
		const acceptedCanonicalIds = formalArtifacts
			.filter((artifact) => artifact.layer === "canonical" && artifact.status === "complete")
			.map((artifact) => artifact.artifactId);
		expect(observationUnit?.canonicalArtifactIds).toEqual(acceptedCanonicalIds);

		const events = readRunEvents(cwd, runId);
		expect(events.map((event) => event.eventType)).toEqual(
			expect.arrayContaining(["run_started", "unit_started", "unit_completed", "run_completed"]),
		);
	});

	it("keeps live retry artifacts in distinct attempts under one logical point scope", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		registerRamanLiveRuntime(cwd, createLiveRuntime(true, true, undefined, undefined, [0.1, 0.96], join(cwd, "driver-artifacts")));
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = {
			...createSinglePointSpec({ procedureId: "raman_grid_mapping" }),
			stoppingRules: { maxRuntimeMinutes: 20, maxUnits: 1, stopOnError: false, maxConsecutiveFailures: 1 },
		};
		const proposalId = await proposeRun(extension, spec, context);
		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-retry-artifacts",
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
		await pollUntilTerminal(extension, runId, context, ["completed"]);
		const autofocusArtifacts = readArtifactRecords(cwd, runId)
			.map((record) => record.artifact)
			.filter((artifact) => artifact.kind === "raman-autofocus");

		expect(autofocusArtifacts.map((artifact) => artifact.path)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("unit-0000/attempts/attempt-0000-initial/"),
				expect.stringContaining("unit-0000/attempts/attempt-0001-immediate_retry/"),
			]),
		);
		expect(new Set(autofocusArtifacts.map((artifact) => artifact.artifactId)).size).toBe(2);
		const driverAutofocusArtifacts = readArtifactRecords(cwd, runId)
			.map((record) => record.artifact)
			.filter((artifact) => artifact.kind === "autofocus");
		expect(driverAutofocusArtifacts.map((artifact) => artifact.path)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("unit-0000/attempts/attempt-0000-initial/autofocus-curve-0-0-1/representations/autofocus-curve.json"),
				expect.stringContaining("unit-0000/attempts/attempt-0001-immediate_retry/autofocus-curve-0-1-1/representations/autofocus-curve.json"),
			]),
		);
		expect(
			driverAutofocusArtifacts.every((artifact) => existsSync(join(cwd, "lab-records", "runs", runId, artifact.path))),
		).toBe(true);
	});

	it("executes a live current-position single-point run without issuing a stage move", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		const metrics = { stageMoveCalls: 0 };
		registerRamanLiveRuntime(cwd, createLiveRuntime(true, true, undefined, metrics, undefined, join(cwd, "driver-artifacts")));
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec({ currentPosition: true });
		const proposalId = await proposeRun(extension, spec, context);

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-current-position",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);

		expect(terminalState.status).toBe("completed");
		expect(metrics.stageMoveCalls).toBe(0);
	});

	it("executes live bounded parameter search and stops early once acceptable conditions are confirmed", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		registerRamanLiveRuntime(
			cwd,
			createLiveRuntime(
				true,
				true,
				[
					{ saturated: false, snr: 12, targetPeakBaselineRatio: 1.8 },
					{ saturated: false, snr: 13, targetPeakBaselineRatio: 1.9 },
					{ saturated: true, snr: 1, targetPeakBaselineRatio: 0.2 },
				],
				undefined,
				undefined,
				join(cwd, "driver-artifacts"),
			),
		);
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const spec = createSinglePointSpec({ procedureId: "raman_parameter_search", maxAttempts: 3 });
		const proposalId = await proposeRun(extension, spec, context);

		const started = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-search",
			{
				proposalId,
				spec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);
		const runId = (started?.details as Record<string, unknown>).runId as string;
		const terminalState = await pollUntilTerminal(extension, runId, context, ["completed"]);

		expect(terminalState.status).toBe("completed");
		expect((terminalState.progress as Record<string, unknown>).completedUnits).toBe(2);

		const events = readRunEvents(cwd, runId).filter((event) => event.eventType === "unit_completed");
		expect(events).toHaveLength(2);
		expect(
			events.map(
				(event) => ((event.payload as Record<string, unknown>).acquisition ?? {}) as Record<string, unknown>,
			),
		).toEqual([
			expect.objectContaining({ laserPowerPercent: 0.01, integrationTimeMs: 1000, accumulations: 1 }),
			expect.objectContaining({ laserPowerPercent: 0.1, integrationTimeMs: 2000, accumulations: 2 }),
		]);
	});

	it("rechecks live admission instead of trusting caller flags and blocks forbidden proposals", async () => {
		const cwd = createTempCwd();
		tempRoots.push(cwd);
		registerRamanLiveRuntime(cwd, createLiveRuntime(true, false));
		const extension = loadExperimentExtension();
		const context = { cwd } as ExtensionContext;
		const safeSpec = createSinglePointSpec();
		const safeProposalId = await proposeRun(extension, safeSpec, context);

		const blockedStart = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-blocked",
			{
				proposalId: safeProposalId,
				spec: safeSpec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);
		expect((blockedStart?.details as Record<string, unknown>).errorCode).toBe("control_not_available");

		registerRamanLiveRuntime(cwd, createLiveRuntime(true, true));
		const mismatchedResourceSpec = {
			...createSinglePointSpec(),
			procedureSpecId: "proc-live-resource-mismatch",
			resources: [
				{ resourceId: "wrong-stage", role: "stage" },
				{ resourceId: "frame-main", role: "frame_provider" },
				{ resourceId: "spectrometer-main", role: "spectrometer" },
			],
		};
		const mismatchedProposalId = await proposeRun(extension, mismatchedResourceSpec, context);
		const mismatchedStart = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-resource-mismatch",
			{
				proposalId: mismatchedProposalId,
				spec: mismatchedResourceSpec,
				executionMode: "live-supervised",
				admission: { preflightReady: true, controlAvailable: true },
			},
			undefined,
			undefined,
			context,
		);
		expect((mismatchedStart?.details as Record<string, unknown>).errorCode).toBe("preflight_forbidden");

		const highPowerSpec = createSinglePointSpec({ laserPowerPercent: 3.2 });
		const highPowerProposalId = await proposeRun(extension, highPowerSpec, context);
		const highPowerStarted = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-power",
			{
				proposalId: highPowerProposalId,
				spec: highPowerSpec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);
		expect((highPowerStarted?.details as Record<string, unknown>).errorCode).toBe("preflight_forbidden");

		const lowClearanceSpec = createSinglePointSpec({ pointZUm: 100 });
		const lowClearanceProposalId = await proposeRun(extension, lowClearanceSpec, context);
		const lowClearanceStarted = await extension.tools.get("approve_and_start_run")?.execute(
			"approve-live-clearance",
			{
				proposalId: lowClearanceProposalId,
				spec: lowClearanceSpec,
				executionMode: "live-supervised",
				admission: {
					preflightReady: true,
					controlAvailable: true,
				},
			},
			undefined,
			undefined,
			context,
		);
		expect((lowClearanceStarted?.details as Record<string, unknown>).errorCode).toBe("preflight_stage_anchor_invalid");
	});
});
