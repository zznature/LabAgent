import { describe, expect, it } from "vitest";
import {
	ActionResultValidator,
	AutofocusRunSingleActionValidator,
	FrameCaptureLatestActionValidator,
	failedActionResult,
	pausedActionResult,
	RamanResourceValidator,
	RamanRuntimeActionValidator,
	SpectrometerAcquireSpectrumActionValidator,
	StageGetPositionActionValidator,
	StageMoveAbsoluteAndWaitActionValidator,
	StageResourceValidator,
	successActionResult,
} from "../runtime/raman/index.ts";

describe("experiment research Raman runtime contract", () => {
	it("accepts the MVP Raman resource definitions for stage, frame provider, and spectrometer", () => {
		const stage = {
			resourceId: "mc_newton_xyz_main",
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
		};

		const frameProvider = {
			resourceId: "labspec_frame_main",
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
		};

		const spectrometer = {
			resourceId: "labspec_main",
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
		};

		expect(StageResourceValidator.Check(stage)).toBe(true);
		expect(RamanResourceValidator.Check(stage)).toBe(true);
		expect(RamanResourceValidator.Check(frameProvider)).toBe(true);
		expect(RamanResourceValidator.Check(spectrometer)).toBe(true);
	});

	it("accepts the MVP runtime actions for motion, autofocus, frame capture, and spectrum acquisition", () => {
		const getPositionAction = {
			action: "stage.get_position",
			resourceId: "mc_newton_xyz_main",
			timeoutMs: 2_000,
		};
		const moveAction = {
			action: "stage.move_absolute_and_wait",
			resourceId: "mc_newton_xyz_main",
			target: { xUm: 1000, yUm: 2000, zUm: 50 },
			timeoutMs: 5_000,
		};
		const autofocusAction = {
			action: "autofocus.run_single",
			stageResourceId: "mc_newton_xyz_main",
			frameProviderResourceId: "labspec_frame_main",
			roi: { x: 200, y: 120, width: 180, height: 180 },
			params: {
				zStartUm: 340,
				zEndUm: 260,
				pointCount: 10,
				stageTimeoutMs: 3000,
				frameTimeoutMs: 500,
				settleMs: 100,
				framesPerZ: 1,
				warmupFramesPerZ: 1,
				targetToleranceUm: 5,
				finalToleranceUm: 5,
				finalApproachOffsetUm: 3,
				interpolatePeak: true,
				finalVerificationFramesPerZ: 1,
				metricName: "labspec_spot_compactness",
			},
			timeoutMs: 15_000,
		};
		const frameAction = {
			action: "frame.capture_latest",
			resourceId: "labspec_frame_main",
			timeoutMs: 2_000,
			laserOff: true,
		};
		const spectrumAction = {
			action: "spectrometer.acquire_spectrum",
			resourceId: "labspec_main",
			acquisition: {
				integrationTimeMs: 10_000,
				laserPowerPercent: 0.1,
				accumulations: 1,
				saveFormat: "txt",
			},
			timeoutMs: 30_000,
		};

		expect(StageGetPositionActionValidator.Check(getPositionAction)).toBe(true);
		expect(StageMoveAbsoluteAndWaitActionValidator.Check(moveAction)).toBe(true);
		expect(AutofocusRunSingleActionValidator.Check(autofocusAction)).toBe(true);
		expect(FrameCaptureLatestActionValidator.Check(frameAction)).toBe(true);
		expect(SpectrometerAcquireSpectrumActionValidator.Check(spectrumAction)).toBe(true);
		expect(RamanRuntimeActionValidator.Check(getPositionAction)).toBe(true);
		expect(RamanRuntimeActionValidator.Check(moveAction)).toBe(true);
		expect(RamanRuntimeActionValidator.Check(autofocusAction)).toBe(true);
		expect(RamanRuntimeActionValidator.Check(frameAction)).toBe(true);
		expect(RamanRuntimeActionValidator.Check(spectrumAction)).toBe(true);
	});

	it("normalizes action results into one unified action result contract", () => {
		const success = successActionResult("Stage moved to the requested point.", {
			finalPosition: { xUm: 1000, yUm: 2000, zUm: 50 },
		});
		const failure = failedActionResult("Autofocus failed with low confidence.", {
			errorCode: "autofocus_low_confidence",
			message: "Autofocus confidence stayed below threshold.",
			retrySafe: true,
			needsOperator: true,
			safeToResume: true,
		}, {
			confidence: 0.01,
			zBestUm: 1540,
		});
		const paused = pausedActionResult("Spectrum acquisition paused for operator review.", {
			checkpoint: "before_acquire_spectrum",
		});

		expect(ActionResultValidator.Check(success)).toBe(true);
		expect(ActionResultValidator.Check(failure)).toBe(true);
		expect(ActionResultValidator.Check(paused)).toBe(true);
		expect(success.status).toBe("success");
		expect(failure.errorCode).toBe("autofocus_low_confidence");
		expect(failure.payload?.confidence).toBe(0.01);
		expect(paused.needsOperator).toBe(true);
		expect(paused.safeToResume).toBe(true);
	});
});
