import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import {
	defaultFocusPlaneCorners,
	fitFocusPlane,
	isPointInConvexRegion,
	type FocusPlaneCorner,
	validateFocusPlaneCorners,
} from "../planner/focus-plane.ts";
import { buildProcedureSpec } from "../planner/procedure-spec-builder.ts";
import { successActionResult } from "../runtime/raman/actions.ts";
import {
	runLiveRamanUnit,
	validateRuntimeAnchorState,
	type RamanLiveRuntime,
} from "../runtime/raman/live-runtime.ts";
import type { RunState } from "../schemas/index.ts";
import type { ProcedureSpec } from "../schemas/procedure-spec.ts";
import { ProcedureSpecValidator } from "../schemas/procedure-spec.ts";
import { readArtifactRecords } from "../store/artifact-store.ts";
import { writeRunStateSnapshot } from "../store/run-store.ts";

const intent = {
	intentId: "intent-focus-plane",
	experimentId: "experiment-focus-plane",
	objective: "Calibrate and map a tilted sample.",
	successCriteria: ["Five accepted focus anchors"],
};

const resources = {
	stageResourceId: "stage-main",
	frameProviderResourceId: "frame-main",
	spectrometerResourceId: "spectrometer-main",
};

const limits = {
	xRangeUm: { minUm: -2_000, maxUm: 2_000 },
	yRangeUm: { minUm: -2_000, maxUm: 2_000 },
	zRangeUm: { minUm: 0, maxUm: 2_000 },
};

const autofocus = {
	enabled: true,
	roi: { x: 0, y: 0, width: 64, height: 64 },
};

const acquisition = {
	integrationTimeMs: 100,
	laserPowerPercent: 0,
	accumulations: 1,
};

describe("focus-plane calibration and mapping", () => {
	it("defaults to a 1000 um square centered on the current XY position", () => {
		expect(defaultFocusPlaneCorners({ xUm: 100, yUm: 200 })).toEqual([
			{ anchorId: "corner_1", xUm: -400, yUm: -300 },
			{ anchorId: "corner_2", xUm: 600, yUm: -300 },
			{ anchorId: "corner_3", xUm: 600, yUm: 700 },
			{ anchorId: "corner_4", xUm: -400, yUm: 700 },
		]);
	});

	it("rejects corners that do not form a four-vertex convex region", () => {
		expect(() =>
			validateFocusPlaneCorners([
				{ anchorId: "corner_1", xUm: 0, yUm: 0 },
				{ anchorId: "corner_2", xUm: 100, yUm: 0 },
				{ anchorId: "corner_3", xUm: 50, yUm: 20 },
				{ anchorId: "corner_4", xUm: 0, yUm: 100 },
			]),
		).toThrow(/convex quadrilateral/u);
	});

	it("fits z = a*x + b*y + c from five anchors", () => {
		const model = fitFocusPlane([
			{ anchorId: "corner_1", xUm: -500, yUm: -500, zUm: 975 },
			{ anchorId: "corner_2", xUm: 500, yUm: -500, zUm: 1025 },
			{ anchorId: "corner_3", xUm: 500, yUm: 500, zUm: 1025 },
			{ anchorId: "corner_4", xUm: -500, yUm: 500, zUm: 975 },
			{ anchorId: "center", xUm: 0, yUm: 0, zUm: 1000 },
		]);

		expect(model.a).toBeCloseTo(0.05);
		expect(model.b).toBeCloseTo(0);
		expect(model.c).toBeCloseTo(1000);
		expect(model.anchorCount).toBe(5);
		expect(model.rmsErrorUm).toBeCloseTo(0);
	});

	it("compiles a calibration run into progressive XY waypoints and five fit anchors", () => {
		const spec = buildProcedureSpec({
			procedureId: "raman_focus_plane_calibration",
			intent,
			resources,
			limits,
			autofocus,
			acquisition,
			currentPosition: { xUm: 0, yUm: 0, zUm: 1000 },
			maxXySpanUm: 250,
		});

		expect(ProcedureSpecValidator.Check(spec)).toBe(true);
		const units = compileProcedureSpec(spec);
		expect(units.filter((unit) => unit.focusCalibration?.sampleRole === "anchor")).toHaveLength(5);
		expect(units.some((unit) => unit.focusCalibration?.sampleRole === "waypoint")).toBe(true);
		expect(units.every((unit) => unit.point?.zUm === 1000)).toBe(true);
		expect(units.at(-1)?.focusCalibration?.finalAnchor).toBe(true);
		const truncated = structuredClone(spec);
		truncated.stoppingRules = { maxUnits: 1 };
		expect(() => compileProcedureSpec(truncated)).toThrow(/cannot truncate the model-producing run/u);
	});

	it("bounds the first XY leg from the frozen current position to a custom calibration center", () => {
		const spec = buildProcedureSpec({
			procedureId: "raman_focus_plane_calibration",
			intent,
			resources,
			limits,
			autofocus,
			acquisition,
			currentPosition: { xUm: 0, yUm: 0, zUm: 1000 },
			corners: [
				{ xUm: 500, yUm: 500 },
				{ xUm: 1500, yUm: 500 },
				{ xUm: 1500, yUm: 1500 },
				{ xUm: 500, yUm: 1500 },
			],
			maxXySpanUm: 250,
		});
		const units = compileProcedureSpec(spec);
		let previous = { xUm: 0, yUm: 0 };
		for (const unit of units) {
			expect(Math.hypot(unit.point!.xUm - previous.xUm, unit.point!.yUm - previous.yUm)).toBeLessThanOrEqual(250);
			previous = unit.point!;
		}
		expect(units.find((unit) => unit.focusCalibration?.anchorId === "center")?.point).toMatchObject({
			xUm: 1000,
			yUm: 1000,
		});
	});

	it("requires a calibration model unless the user explicitly declines correction", () => {
		const input = {
			procedureId: "raman_grid_mapping" as const,
			intent,
			resources,
			limits,
			autofocus,
			acquisition,
			grid: {
				origin: { xUm: 0, yUm: 0, zUm: 1_000 },
				rows: 1,
				cols: 1,
				pitchXUm: 10,
				pitchYUm: 10,
			},
		};
		expect(() => buildProcedureSpec(input)).toThrow(/requires focus-plane calibration by default/u);
		const declined = buildProcedureSpec({ ...input, focusPlaneDecision: "user_declined" });
		expect(declined.plan.kind === "grid_scan" ? declined.plan.surfaceCorrection : undefined).toEqual({
			kind: "disabled",
			reason: "user_declined",
		});
	});

	it("rejects raw point-list mapping that bypasses the focus-plane decision", () => {
		const spec: ProcedureSpec = {
			procedureSpecId: "raw-point-list-mapping",
			experimentId: intent.experimentId,
			intentId: intent.intentId,
			procedureId: "raman_grid_mapping",
			procedureVersion: "0.1.0",
			resources: [
				{ resourceId: "stage-main", role: "stage" },
				{ resourceId: "frame-main", role: "frame_provider" },
				{ resourceId: "spectrometer-main", role: "spectrometer" },
			],
			limits,
			plan: {
				kind: "point_list",
				points: [{ xUm: 0, yUm: 0, zUm: 1000 }],
				perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			},
			domain: {
				raman: { autofocus, acquisition },
			},
		};

		expect(ProcedureSpecValidator.Check(spec)).toBe(true);
		expect(() => compileProcedureSpec(spec)).toThrow(/Mapping requires focus-plane calibration by default/u);
	});

	it("requires fixed Z for every point-list mapping point when correction is explicitly declined", () => {
		const spec: ProcedureSpec = {
			procedureSpecId: "declined-point-list-mapping",
			experimentId: intent.experimentId,
			intentId: intent.intentId,
			procedureId: "raman_grid_mapping",
			procedureVersion: "0.1.0",
			resources: [
				{ resourceId: "stage-main", role: "stage" },
				{ resourceId: "frame-main", role: "frame_provider" },
				{ resourceId: "spectrometer-main", role: "spectrometer" },
			],
			limits,
			plan: {
				kind: "point_list",
				points: [{ xUm: 0, yUm: 0 }],
				surfaceCorrection: { kind: "disabled", reason: "user_declined" },
				perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			},
			domain: {
				raman: { autofocus, acquisition },
			},
		};

		expect(ProcedureSpecValidator.Check(spec)).toBe(true);
		expect(() => compileProcedureSpec(spec)).toThrow(/every point_list point to include an explicit fixed zUm/u);
	});

	it("rejects a proposal when the complete local autofocus window exceeds approved Z limits", () => {
		const region = defaultFocusPlaneCorners({ xUm: 0, yUm: 0 });
		const spec = buildProcedureSpec({
			procedureId: "raman_grid_mapping",
			intent,
			resources,
			limits: { ...limits, zRangeUm: { minUm: 0, maxUm: 2_000 } },
			autofocus,
			acquisition,
			grid: {
				origin: { xUm: 0, yUm: 0 },
				rows: 1,
				cols: 1,
				pitchXUm: 10,
				pitchYUm: 10,
			},
			focusPlane: {
				calibrationRunId: "run-calibration",
				artifactId: "focus-plane-artifact",
				checksum: "sha256:abc",
				a: 0,
				b: 0,
				c: 20,
				validRegion: region,
			},
		});
		expect(() => compileProcedureSpec(spec)).toThrow(/Autofocus window.*exceeds the approved Z range/u);
	});

	it("predicts mapping Z from the approved plane and freezes a +/-40 um correction", () => {
		const region = defaultFocusPlaneCorners({ xUm: 0, yUm: 0 });
		const spec = buildProcedureSpec({
			procedureId: "raman_grid_mapping",
			intent,
			resources,
			limits,
			autofocus,
			acquisition,
			grid: {
				origin: { xUm: -100, yUm: -100 },
				rows: 2,
				cols: 2,
				pitchXUm: 200,
				pitchYUm: 200,
			},
			focusPlane: {
				calibrationRunId: "run-calibration",
				artifactId: "focus-plane-artifact",
				checksum: "sha256:abc",
				a: 0.05,
				b: -0.02,
				c: 1000,
				validRegion: region,
			},
		});

		expect(ProcedureSpecValidator.Check(spec)).toBe(true);
		expect(spec.plan.kind).toBe("grid_scan");
		if (spec.plan.kind !== "grid_scan") {
			throw new Error("expected grid scan");
		}
		expect(
			spec.plan.surfaceCorrection?.kind === "focus_plane"
				? spec.plan.surfaceCorrection.localAutofocusHalfRangeUm
				: undefined,
		).toBe(40);
		expect(isPointInConvexRegion({ xUm: 0, yUm: 0 }, region)).toBe(true);
		expect(compileProcedureSpec(spec).map((unit) => unit.point?.zUm)).toEqual([997, 1007, 993, 1003]);
		const wrongOrder = structuredClone(spec);
		if (wrongOrder.plan.kind !== "grid_scan") {
			throw new Error("expected grid scan");
		}
		wrongOrder.plan.perPoint = [
			{ kind: "autofocus" },
			{ kind: "move_to_point" },
			{ kind: "acquire_spectrum" },
		];
		expect(() => compileProcedureSpec(wrongOrder)).toThrow(/then one autofocus, then one acquire_spectrum/u);
	});

	it("executes calibration coarse-to-fine, publishes a model, then maps with +/-40 um correction", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "focus-plane-live-"));
		try {
			const autofocusActions: Array<{ params: { zStartUm: number; zEndUm: number; strategy?: string } }> = [];
			let position = { xUm: 1_000, yUm: 1_000, zUm: 1_000 };
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
						position = { xUm: action.target.xUm, yUm: action.target.yUm, zUm: action.target.zUm ?? position.zUm };
						return successActionResult("moved", { position });
					},
				},
				autofocus: {
					runSingle: (action: { params: { zStartUm: number; zEndUm: number; strategy?: string } }) => {
						autofocusActions.push(action);
						const zBestUm = (action.params.zStartUm + action.params.zEndUm) / 2 + 1;
						position = { ...position, zUm: zBestUm };
						return successActionResult("focused", {
							zBestUm,
							confidence: 1,
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
			const calibrationSpec = buildProcedureSpec({
				procedureId: "raman_focus_plane_calibration",
				intent,
				resources,
				limits: {
					xRangeUm: { minUm: 0, maxUm: 5_000 },
					yRangeUm: { minUm: 0, maxUm: 5_000 },
					zRangeUm: { minUm: 0, maxUm: 5_000 },
				},
				autofocus,
				acquisition,
				currentPosition: position,
				maxXySpanUm: 2_000,
			});
			const calibrationRunId = "calibration-run";
			position = { ...position, xUm: 1_100 };
			expect((await validateRuntimeAnchorState(calibrationSpec, runtime)).valid).toBe(false);
			position = { xUm: 1_000, yUm: 1_000, zUm: 1_000 };
			for (const unit of compileProcedureSpec(calibrationSpec)) {
				const result = await runLiveRamanUnit(
					cwd,
					calibrationRunId,
					unit,
					calibrationSpec,
					runtime,
					{} as RunState,
				);
				expect(result.status).toBe("completed");
			}
			expect(autofocusActions.every((action) => action.params.zEndUm - action.params.zStartUm === 200)).toBe(true);
			expect(autofocusActions.every((action) => action.params.strategy === "calibration_coarse_to_fine")).toBe(true);

			const planeRecord = readArtifactRecords(cwd, calibrationRunId).find(
				(record) => record.artifact.kind === "raman-focus-plane",
			);
			expect(planeRecord).toBeDefined();
			const plane = JSON.parse(
				readFileSync(join(cwd, "lab-records", "runs", calibrationRunId, planeRecord!.artifact.path), "utf-8"),
			) as { model: { a: number; b: number; c: number }; validRegion: FocusPlaneCorner[] };
			const mappingSpec = buildProcedureSpec({
				procedureId: "raman_grid_mapping",
				intent,
				resources,
				limits: calibrationSpec.limits,
				autofocus,
				acquisition,
				grid: {
					origin: { xUm: 1_000, yUm: 1_000 },
					rows: 1,
					cols: 1,
					pitchXUm: 10,
					pitchYUm: 10,
				},
				focusPlane: {
					calibrationRunId,
					artifactId: planeRecord!.artifact.artifactId,
					checksum: planeRecord!.artifact.metadata!.checksum as string,
					...plane.model,
					validRegion: plane.validRegion,
				},
			});
			const calibrationArtifacts = readArtifactRecords(cwd, calibrationRunId).map((record) => record.artifact);
			const completedUnits = compileProcedureSpec(calibrationSpec).length;
			writeRunStateSnapshot(cwd, {
				runId: calibrationRunId,
				experimentId: calibrationSpec.experimentId,
				procedureSpecId: calibrationSpec.procedureSpecId,
				status: "failed",
				progress: { completedUnits, failedUnits: 1, totalUnits: completedUnits, unitKind: "point" },
				artifactRefs: calibrationArtifacts,
				startedAt: "2026-07-24T00:00:00.000Z",
				updatedAt: "2026-07-24T00:00:01.000Z",
				endedAt: "2026-07-24T00:00:01.000Z",
			});
			const incompleteCalibrationResult = await runLiveRamanUnit(
				cwd,
				"mapping-run-incomplete-calibration",
				compileProcedureSpec(mappingSpec)[0]!,
				mappingSpec,
				runtime,
				{} as RunState,
			);
			expect(incompleteCalibrationResult.status).toBe("failed");
			if (incompleteCalibrationResult.status === "failed") {
				expect(incompleteCalibrationResult.error.errorCode).toBe("focus_plane_calibration_run_not_completed");
			}
			writeRunStateSnapshot(cwd, {
				runId: calibrationRunId,
				experimentId: calibrationSpec.experimentId,
				procedureSpecId: calibrationSpec.procedureSpecId,
				status: "completed",
				progress: { completedUnits, failedUnits: 0, totalUnits: completedUnits, unitKind: "point" },
				artifactRefs: calibrationArtifacts,
				startedAt: "2026-07-24T00:00:00.000Z",
				updatedAt: "2026-07-24T00:00:02.000Z",
				endedAt: "2026-07-24T00:00:02.000Z",
			});
			const mappingResult = await runLiveRamanUnit(
				cwd,
				"mapping-run",
				compileProcedureSpec(mappingSpec)[0]!,
				mappingSpec,
				runtime,
				{} as RunState,
			);
			expect(mappingResult.status).toBe("completed");
			const mappingAutofocus = autofocusActions.at(-1)!;
			expect(mappingAutofocus.params.strategy).toBe("mapping_local_correction");
			expect(mappingAutofocus.params.zEndUm - mappingAutofocus.params.zStartUm).toBe(80);

			const tamperedMappingSpec = structuredClone(mappingSpec);
			if (
				tamperedMappingSpec.plan.kind !== "grid_scan" ||
				tamperedMappingSpec.plan.surfaceCorrection?.kind !== "focus_plane"
			) {
				throw new Error("expected corrected grid mapping");
			}
			tamperedMappingSpec.plan.surfaceCorrection.validRegion = [
				{ anchorId: "corner_1", xUm: 0, yUm: 0 },
				{ anchorId: "corner_2", xUm: 2_000, yUm: 0 },
				{ anchorId: "corner_3", xUm: 2_000, yUm: 2_000 },
				{ anchorId: "corner_4", xUm: 0, yUm: 2_000 },
			];
			const tamperedResult = await runLiveRamanUnit(
				cwd,
				"tampered-mapping-run",
				compileProcedureSpec(tamperedMappingSpec)[0]!,
				tamperedMappingSpec,
				runtime,
				{} as RunState,
			);
			expect(tamperedResult.status).toBe("failed");
			if (tamperedResult.status === "failed") {
				expect(tamperedResult.error.errorCode).toBe("focus_plane_artifact_mismatch");
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
