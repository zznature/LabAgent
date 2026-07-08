import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRamanPythonRuntime,
	RamanPythonDaemon,
	RAMAN_RUNTIME_DAEMON_SCRIPT,
	shutdownRamanPythonDaemon,
	type RamanPythonRuntimeConfig,
} from "../runtime/raman/python-runtime.ts";

// A Node-based stand-in for the Python daemon. It speaks the same
// newline-delimited JSON protocol so the TypeScript daemon client can be tested
// end-to-end without Python or real hardware. It also emits stderr chatter and
// one stray stdout line to prove the client tolerates non-protocol output.
const FAKE_DAEMON_SOURCE = String.raw`
const readline = require("node:readline");
process.stderr.write("vendor sdk chatter to stderr\n");
process.stdout.write("non-json startup banner that must be ignored\n");
let active = 0;
let maxActive = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  const req = JSON.parse(line);
  active += 1;
  maxActive = Math.max(maxActive, active);
  const delayMs = req.payload && typeof req.payload.delayMs === "number" ? req.payload.delayMs : 0;
  setTimeout(() => {
    active -= 1;
    const payload = { maxActive };
    let response = { requestId: req.requestId, ok: true, summary: req.action + " ok", payload };
    if (req.action === "stage_position") {
      payload.position = { xUm: 11, yUm: 22, zUm: 33 };
    } else if (req.action === "stage_move") {
      payload.finalPosition = req.payload.target;
      payload.stageMoveCommands = [{ axis: "z", target_um: req.payload.target.zUm, method: "fake.move" }];
      payload.stageSettleDiagnostics = { status: "settled", axes: ["z"] };
    } else if (req.action === "frame_capture") {
      payload.framePath = "D:\\RamanLab\\SpecBridge\\frames\\frame_1.tif";
    } else if (req.action === "spectrum") {
      payload.outputPath = "D:\\RamanLab\\SpecBridge\\spectra\\" + req.payload.pointId + ".txt";
      payload.spectrumPlotPath = "D:\\RamanLab\\SpecBridge\\spectra\\" + req.payload.pointId + ".png";
      payload.snr = 12;
      payload.saturated = false;
      payload.targetPeakBaselineRatio = 1.8;
    } else if (req.action === "autofocus") {
      payload.status = "ok";
      payload.zBestUm = 260;
      payload.confidence = 0.95;
      payload.params = {
        zStartUm: req.payload.params.zStartUm,
        zEndUm: req.payload.params.zEndUm,
        effectivePointCount: 10,
        warmupFramesPerZ: req.payload.params.warmupFramesPerZ ?? 1
      };
      payload.scanPoints = [{ zUm: 260, score: 1.2, saturationRatio: 0 }];
      payload.stageMoveCommands = [{ axis: "z", target_um: 260, method: "fake.move" }];
      payload.stageSettleDiagnostics = { status: "settled", axes: ["z"] };
    } else if (req.action === "preflight") {
      payload.pythonRootExists = true;
    }
    process.stdout.write(JSON.stringify(response) + "\n");
  }, delayMs);
});
`;

const tempRoots: string[] = [];
const liveCwds: string[] = [];
const liveDaemons: RamanPythonDaemon[] = [];

afterEach(async () => {
	while (liveDaemons.length > 0) {
		liveDaemons.pop()?.shutdown();
	}
	while (liveCwds.length > 0) {
		const cwd = liveCwds.pop();
		if (cwd) {
			shutdownRamanPythonDaemon(cwd);
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
	while (tempRoots.length > 0) {
		const path = tempRoots.pop();
		if (path) {
			rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
});

function createDriverRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-exp-daemon-"));
	tempRoots.push(root);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, RAMAN_RUNTIME_DAEMON_SCRIPT), FAKE_DAEMON_SOURCE, "utf-8");
	return root;
}

function createConfig(pythonRoot: string): RamanPythonRuntimeConfig {
	return {
		enabled: true,
		pythonExecutable: process.execPath,
		pythonRoot,
		daemon: { idleShutdownMs: 60_000 },
		stage: {
			resourceId: "stage-main",
			kind: "stage",
			runtime: "raman_python",
			driver: "mc_newton_xyz",
			config: { port: "COM5", xChannel: 1, yChannel: 2, zChannel: 3, baudrate: 115200 },
			leasePolicy: "exclusive",
			simulationAvailable: true,
			limits: { xRangeUm: [0, 50_000], yRangeUm: [0, 50_000], zRangeUm: [0, 5_000] },
		},
		frameProvider: {
			resourceId: "frame-main",
			kind: "frame_provider",
			runtime: "raman_python",
			driver: "labspec_file_bridge_frame",
			config: { bridgeDir: "D:\\RamanLab\\SpecBridge", imageFormat: "tif", minCaptureIntervalMs: 400 },
			leasePolicy: "shared-read",
			simulationAvailable: false,
		},
		spectrometer: {
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
	};
}

function createDaemon(pythonRoot: string, idleShutdownMs = 60_000): RamanPythonDaemon {
	const config = createConfig(pythonRoot);
	const daemon = new RamanPythonDaemon({
		command: process.execPath,
		scriptPath: join(pythonRoot, RAMAN_RUNTIME_DAEMON_SCRIPT),
		cwd: pythonRoot,
		pythonRoot,
		stage: config.stage,
		frameProvider: config.frameProvider,
		spectrometer: config.spectrometer,
		idleShutdownMs,
	});
	liveDaemons.push(daemon);
	return daemon;
}

describe("experiment research Raman Python daemon transport", () => {
	it("maps daemon responses to action results and emits artifacts through one persistent process", async () => {
		const root = createDriverRoot();
		const cwd = mkdtempSync(join(tmpdir(), "pi-exp-daemon-cwd-"));
		tempRoots.push(cwd);
		liveCwds.push(cwd);
		const runtime = createRamanPythonRuntime(cwd, createConfig(root));

		const position = await runtime.stage.getPosition({
			action: "stage.get_position",
			resourceId: "stage-main",
			timeoutMs: 5_000,
		});
		expect(position.status).toBe("success");
		expect((position.payload?.position as Record<string, number>).xUm).toBe(11);

		const move = await runtime.stage.moveAbsoluteAndWait({
			action: "stage.move_absolute_and_wait",
			resourceId: "stage-main",
			target: { xUm: 1000, yUm: 2000, zUm: 250 },
			timeoutMs: 5_000,
		});
		expect(move.status).toBe("success");
		expect((move.payload?.finalPosition as Record<string, number>).xUm).toBe(1000);

		const frame = await runtime.frame.captureLatest({
			action: "frame.capture_latest",
			resourceId: "frame-main",
			timeoutMs: 5_000,
		});
		expect(frame.status).toBe("success");
		expect(frame.artifacts.map((artifact) => artifact.kind)).toContain("frame");

		const spectrum = await runtime.spectrometer.acquireSpectrum({
			action: "spectrometer.acquire_spectrum",
			resourceId: "spectrometer-main",
			acquisition: { integrationTimeMs: 1_000, laserPowerPercent: 0.1, accumulations: 1, saveFormat: "txt" },
			timeoutMs: 5_000,
		});
		expect(spectrum.status).toBe("success");
		expect(spectrum.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["spectrum", "spectrum-plot"]);
		expect(spectrum.payload?.snr).toBe(12);

		const autofocus = await runtime.autofocus.runSingle({
			action: "autofocus.run_single",
			stageResourceId: "stage-main",
			frameProviderResourceId: "frame-main",
			roi: { x: 100, y: 100, width: 64, height: 64 },
			params: { zStartUm: 220, zEndUm: 300, pointCount: 10, warmupFramesPerZ: 1 },
			timeoutMs: 5_000,
		});
		expect(autofocus.status).toBe("success");
		expect((autofocus.payload?.params as Record<string, unknown>).effectivePointCount).toBe(10);
		expect(autofocus.payload?.stageSettleDiagnostics).toEqual({ status: "settled", axes: ["z"] });
	});

	it("serializes concurrent actions so the single hardware session is never touched in parallel", async () => {
		const root = createDriverRoot();
		const daemon = createDaemon(root);

		const responses = await Promise.all([
			daemon.request("stage_position", { delayMs: 40 }, 5_000),
			daemon.request("stage_position", { delayMs: 40 }, 5_000),
			daemon.request("stage_position", { delayMs: 40 }, 5_000),
		]);

		for (const response of responses) {
			expect(response.ok).toBe(true);
			expect((response as { payload: Record<string, number> }).payload.maxActive).toBe(1);
		}
	});

	it("times out a stuck action, resets the daemon, and recovers on the next action", async () => {
		const root = createDriverRoot();
		const daemon = createDaemon(root);

		const timedOut = await daemon.request("stage_position", { delayMs: 1_000 }, 150);
		expect(timedOut.ok).toBe(false);
		expect((timedOut as { errorCode: string }).errorCode).toBe("python_runtime_timeout");

		const recovered = await daemon.request("stage_position", { delayMs: 0 }, 5_000);
		expect(recovered.ok).toBe(true);
		const recoveredPayload = recovered.payload as { position: { xUm: number } };
		expect(recoveredPayload.position.xUm).toBe(11);
	});

	it("reports a structured spawn failure when the daemon script is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-exp-daemon-missing-"));
		tempRoots.push(root);
		const daemon = createDaemon(root);

		const response = await daemon.request("stage_position", { delayMs: 0 }, 5_000);
		expect(response.ok).toBe(false);
		expect((response as { errorCode: string }).errorCode).toMatch(/python_runtime_(spawn_failed|exit_failed)/u);
	});
});
