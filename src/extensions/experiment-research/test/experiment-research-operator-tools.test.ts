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
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
}

interface MutablePosition {
	xUm: number;
	yUm: number;
	zUm: number;
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
	const cwd = mkdtempSync(join(tmpdir(), "pi-exp-operator-tools-"));
	tempRoots.push(cwd);
	return cwd;
}

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

function createOperatorRuntime(position: MutablePosition, options: { autofocusZBestUm?: number } = {}): RamanLiveRuntime {
	return {
		preflight() {
			return {
				preflightReady: true,
				controlAvailable: true,
				details: {
					stageConnected: true,
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
					xRangeUm: [0, 2_000],
					yRangeUm: [0, 3_000],
					zRangeUm: [0, 1_000],
				},
			},
			getPosition() {
				return successActionResult("Stage position read.", {
					position: { ...position },
				});
			},
			moveAbsoluteAndWait(action) {
				position.xUm = action.target.xUm;
				position.yUm = action.target.yUm;
				position.zUm = action.target.zUm ?? position.zUm;
				return successActionResult("Stage moved.", {
					finalPosition: { ...position },
				});
			},
		},
		autofocus: {
			runSingle() {
				const zBestUm = options.autofocusZBestUm ?? 320;
				position.zUm = zBestUm;
				return successActionResult(
					"Autofocus completed.",
					{
						zBestUm,
						confidence: 0.9,
						finalScore: 1.2,
					},
					[
						{
							artifactId: "autofocus-curve",
							kind: "autofocus",
							path: "D:/RamanLab/SpecBridge/autofocus/curve.json",
							label: "Autofocus curve",
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
						framePath: "D:\\RamanLab\\SpecBridge\\frames\\frame_1.tif",
						shape: [512, 512],
					},
					[
						{
							artifactId: "frame-latest",
							kind: "frame",
							path: "D:/RamanLab/SpecBridge/frames/frame_1.tif",
							label: "LabSpec frame",
						},
					],
				);
			},
			captureLaserOff() {
				return successActionResult(
					"Laser-off frame captured.",
					{
						framePath: "D:\\RamanLab\\SpecBridge\\frames\\frame_laser_off_1.tif",
						shape: [512, 512],
						laserStateRequested: "off",
					},
					[
						{
							artifactId: "frame-laser-off",
							kind: "frame",
							path: "D:/RamanLab/SpecBridge/frames/frame_laser_off_1.tif",
							label: "LabSpec laser-off frame",
						},
					],
				);
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
				return successActionResult(
					"Spectrum acquired.",
					{
						outputPath: "D:\\RamanLab\\SpecBridge\\spectra\\smoke.txt",
						snr: 12,
					},
					[
						{
							artifactId: "spectrum-smoke",
							kind: "spectrum",
							path: "D:/RamanLab/SpecBridge/spectra/smoke.txt",
							label: "Smoke spectrum",
						},
					],
				);
			},
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(value).toBeTypeOf("object");
	expect(value).not.toBeNull();
	return value as Record<string, unknown>;
}

describe("experiment research operator tools", () => {
	it("reads hardware status and current stage position through the registered runtime", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		registerRamanLiveRuntime(cwd, createOperatorRuntime({ xUm: 100, yUm: 200, zUm: 300 }));
		const context = { cwd } as ExtensionContext;

		const statusResult = await extension.tools
			.get("raman_get_hardware_status")
			?.execute("status", {}, undefined, undefined, context);
		const statusDetails = asRecord(statusResult?.details);
		const statusState = asRecord(statusDetails.stateAfter);

		expect(statusDetails.status).toBe("success");
		expect(asRecord(statusResult).content).toEqual([
			{ type: "text", text: "Raman hardware status is ready. Stage position: X=100 um, Y=200 um, Z=300 um." },
		]);
		expect(statusState.realRuntimeRegistered).toBe(true);
		expect(statusState.preflightReady).toBe(true);
		expect(statusState.stagePosition).toEqual({ xUm: 100, yUm: 200, zUm: 300 });

		const positionResult = await extension.tools
			.get("raman_get_stage_position")
			?.execute("position", {}, undefined, undefined, context);
		const positionDetails = asRecord(positionResult?.details);
		const positionState = asRecord(positionDetails.stateAfter);

		expect(positionDetails.status).toBe("success");
		expect(asRecord(positionResult).content).toEqual([
			{ type: "text", text: "Stage position read: X=100 um, Y=200 um, Z=300 um." },
		]);
		expect(positionState.position).toEqual({ xUm: 100, yUm: 200, zUm: 300 });
	});

	it("requires confirmation for stage relative motion and then executes within stage limits", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const position = { xUm: 100, yUm: 200, zUm: 300 };
		registerRamanLiveRuntime(cwd, createOperatorRuntime(position));
		const context = { cwd } as ExtensionContext;

		const proposalResult = await extension.tools
			.get("raman_stage_move_relative")
			?.execute("move-proposal", { axis: "x", deltaUm: 50 }, undefined, undefined, context);
		const proposalDetails = asRecord(proposalResult?.details);
		const proposalState = asRecord(proposalDetails.stateAfter);

		expect(proposalDetails.status).toBe("warning");
		expect(asRecord(proposalResult).content).toEqual([
			{
				type: "text",
				text: "Stage relative move requires explicit confirmation before execution. Current: X=100 um, Y=200 um, Z=300 um. Target: X=150 um, Y=200 um, Z=300 um.",
			},
		]);
		expect(proposalState.requiresConfirmation).toBe(true);
		expect(proposalState.target).toEqual({ xUm: 150, yUm: 200, zUm: 300 });
		expect(position.xUm).toBe(100);

		const moveResult = await extension.tools
			.get("raman_stage_move_relative")
			?.execute("move-confirmed", { axis: "x", deltaUm: 50, confirmed: true }, undefined, undefined, context);
		const moveDetails = asRecord(moveResult?.details);
		const moveState = asRecord(moveDetails.stateAfter);

		expect(moveDetails.status).toBe("success");
		expect(asRecord(moveResult).content).toEqual([
			{ type: "text", text: "Stage relative move completed. Target: X=150 um, Y=200 um, Z=300 um." },
		]);
		expect(moveState.target).toEqual({ xUm: 150, yUm: 200, zUm: 300 });
		expect(position.xUm).toBe(150);
	});

	it("captures the current microscope frame through the registered runtime", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		registerRamanLiveRuntime(cwd, createOperatorRuntime({ xUm: 100, yUm: 200, zUm: 300 }));
		const context = { cwd } as ExtensionContext;

		const frameResult = await extension.tools
			.get("raman_capture_frame")
			?.execute("frame", {}, undefined, undefined, context);
		const frameDetails = asRecord(frameResult?.details);
		const frameState = asRecord(frameDetails.stateAfter);

		expect(frameDetails.status).toBe("success");
		expect(asRecord(frameResult).content).toEqual([
			{ type: "text", text: "Frame captured: D:\\RamanLab\\SpecBridge\\frames\\frame_1.tif." },
		]);
		expect(frameState.frameProviderResourceId).toBe("frame-main");
		expect(frameState.artifactRefs).toEqual([
			{
				artifactId: "frame-latest",
				kind: "frame",
				path: "D:/RamanLab/SpecBridge/frames/frame_1.tif",
				label: "LabSpec frame",
			},
		]);
	});

	it("captures a laser-off microscope frame through the registered runtime", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		registerRamanLiveRuntime(cwd, createOperatorRuntime({ xUm: 100, yUm: 200, zUm: 300 }));
		const context = { cwd } as ExtensionContext;

		const frameResult = await extension.tools
			.get("raman_capture_laser_off_frame")
			?.execute("frame-laser-off", {}, undefined, undefined, context);
		const frameDetails = asRecord(frameResult?.details);
		const frameState = asRecord(frameDetails.stateAfter);

		expect(frameDetails.status).toBe("success");
		expect(asRecord(frameResult).content).toEqual([
			{ type: "text", text: "Laser-off frame captured: D:\\RamanLab\\SpecBridge\\frames\\frame_laser_off_1.tif." },
		]);
		expect(frameState.laserStateRequested).toBe("off");
		expect(frameState.artifactRefs).toEqual([
			{
				artifactId: "frame-laser-off",
				kind: "frame",
				path: "D:/RamanLab/SpecBridge/frames/frame_laser_off_1.tif",
				label: "LabSpec laser-off frame",
			},
		]);
	});

	it("requires confirmation for autofocus and rejects an unsafe autofocus result", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const position = { xUm: 100, yUm: 200, zUm: 300 };
		registerRamanLiveRuntime(cwd, createOperatorRuntime(position));
		const context = { cwd } as ExtensionContext;

		const proposalResult = await extension.tools
			.get("raman_run_autofocus")
			?.execute("autofocus-proposal", { zStartUm: 260, zEndUm: 340 }, undefined, undefined, context);
		const proposalDetails = asRecord(proposalResult?.details);
		const proposalState = asRecord(proposalDetails.stateAfter);

		expect(proposalDetails.status).toBe("warning");
		expect(proposalState.requiresConfirmation).toBe(true);
		expect(proposalState.confirmed).toBe(false);
		expect(asRecord(proposalState.roi)).toEqual({ x: 100, y: 100, width: 64, height: 64 });
		expect(asRecord(proposalState.params).zStartUm).toBe(260);
		expect(asRecord(proposalState.params).zEndUm).toBe(340);
		expect(proposalState.timeoutMs).toBe(150_000);

		const autofocusResult = await extension.tools
			.get("raman_run_autofocus")
			?.execute("autofocus-confirmed", { zStartUm: 260, zEndUm: 340, confirmed: true }, undefined, undefined, context);
		const autofocusDetails = asRecord(autofocusResult?.details);
		const autofocusState = asRecord(autofocusDetails.stateAfter);

		expect(autofocusDetails.status).toBe("success");
		expect(asRecord(autofocusResult).content).toEqual([{ type: "text", text: "Autofocus completed at Z=320 um." }]);
		expect(asRecord(autofocusState.payload).zBestUm).toBe(320);
		expect(position.zUm).toBe(320);

		const unsafeCwd = createTempCwd();
		const unsafePosition = { xUm: 100, yUm: 200, zUm: 300 };
		registerRamanLiveRuntime(unsafeCwd, createOperatorRuntime(unsafePosition, { autofocusZBestUm: 100 }));
		const unsafeContext = { cwd: unsafeCwd } as ExtensionContext;
		const unsafeResult = await extension.tools
			.get("raman_run_autofocus")
			?.execute("autofocus-unsafe", { zStartUm: 260, zEndUm: 340, confirmed: true }, undefined, undefined, unsafeContext);
		const unsafeDetails = asRecord(unsafeResult?.details);

		expect(unsafeDetails.status).toBe("error");
		expect(unsafeDetails.errorCode).toBe("motion_out_of_bounds");
	});

	it("requires confirmation for a low-power smoke spectrum and then returns spectrum artifacts", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		registerRamanLiveRuntime(cwd, createOperatorRuntime({ xUm: 100, yUm: 200, zUm: 300 }));
		const context = { cwd } as ExtensionContext;

		const proposalResult = await extension.tools
			.get("raman_acquire_smoke_spectrum")
			?.execute("smoke-proposal", {}, undefined, undefined, context);
		const proposalDetails = asRecord(proposalResult?.details);
		const proposalState = asRecord(proposalDetails.stateAfter);

		expect(proposalDetails.status).toBe("warning");
		expect(proposalState.requiresConfirmation).toBe(true);
		expect(proposalState.confirmed).toBe(false);
		expect(asRecord(proposalState.acquisition).laserPowerPercent).toBe(0.1);

		const highPowerResult = await extension.tools
			.get("raman_acquire_smoke_spectrum")
			?.execute("smoke-high-power", { laserPowerPercent: 2, confirmed: true }, undefined, undefined, context);
		const highPowerDetails = asRecord(highPowerResult?.details);
		expect(highPowerDetails.status).toBe("error");
		expect(highPowerDetails.errorCode).toBe("laser_power_limit_exceeded");

		const spectrumResult = await extension.tools
			.get("raman_acquire_smoke_spectrum")
			?.execute("smoke-confirmed", { confirmed: true }, undefined, undefined, context);
		const spectrumDetails = asRecord(spectrumResult?.details);
		const spectrumState = asRecord(spectrumDetails.stateAfter);

		expect(spectrumDetails.status).toBe("success");
		expect(asRecord(spectrumResult).content).toEqual([
			{ type: "text", text: "Smoke spectrum acquired: D:\\RamanLab\\SpecBridge\\spectra\\smoke.txt." },
		]);
		expect(spectrumState.artifactRefs).toEqual([
			{
				artifactId: "spectrum-smoke",
				kind: "spectrum",
				path: "D:/RamanLab/SpecBridge/spectra/smoke.txt",
				label: "Smoke spectrum",
			},
		]);
	});

	it("rejects stage relative motion outside runtime resource limits", async () => {
		const cwd = createTempCwd();
		const extension = loadExperimentExtension();
		const position = { xUm: 1_990, yUm: 200, zUm: 300 };
		registerRamanLiveRuntime(cwd, createOperatorRuntime(position));
		const context = { cwd } as ExtensionContext;

		const moveResult = await extension.tools
			.get("raman_stage_move_relative")
			?.execute("move-out-of-bounds", { axis: "x", deltaUm: 50, confirmed: true }, undefined, undefined, context);
		const moveDetails = asRecord(moveResult?.details);
		const moveState = asRecord(moveDetails.stateAfter);

		expect(moveDetails.status).toBe("error");
		expect(moveDetails.errorCode).toBe("motion_out_of_bounds");
		expect(moveState.target).toEqual({ xUm: 2040, yUm: 200, zUm: 300 });
		expect(position.xUm).toBe(1_990);
	});
});
