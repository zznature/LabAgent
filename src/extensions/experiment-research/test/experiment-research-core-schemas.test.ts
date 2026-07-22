import { describe, expect, it } from "vitest";
import {
	ExecutionUnitValidator,
	ExperimentIntentValidator,
	ProcedureSpecValidator,
	RunStateValidator,
	ToolResultValidator,
} from "../schemas/index.ts";

describe("experiment research core schemas", () => {
	it("accepts a minimal experiment intent", () => {
		const intent = {
			intentId: "intent-001",
			experimentId: "exp-001",
			objective: "Find Raman acquisition settings that reveal the target peak without saturation.",
			successCriteria: ["Target peak visible", "No detector saturation"],
		};

		expect(ExperimentIntentValidator.Check(intent)).toBe(true);
	});

	it("rejects experiment intent objects with undeclared fields", () => {
		const intent = {
			intentId: "intent-001",
			experimentId: "exp-001",
			objective: "Probe the sample.",
			plan: "should-not-live-here",
		};

		expect(ExperimentIntentValidator.Check(intent)).toBe(false);
	});

	it("accepts bounded point_list and grid_scan procedure specs", () => {
		const pointListSpec = {
			procedureSpecId: "proc-spec-001",
			experimentId: "exp-001",
			intentId: "intent-001",
			procedureId: "raman_single_point_probe",
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
				points: [{ xUm: 1000, yUm: 2000 }],
				interPointDelayMs: 300_000,
				perPoint: [
					{ kind: "move_to_point" },
					{ kind: "autofocus" },
					{ kind: "capture_frame", laserOff: true },
					{ kind: "acquire_spectrum" },
				],
			},
			stoppingRules: {
				maxRuntimeMinutes: 20,
				maxUnits: 1,
				stopOnError: true,
			},
			retryPolicy: {
				mode: "immediate_then_final",
				maxImmediateRetriesPerPoint: 1,
				maxFinalRetriesPerPoint: 1,
				finalRetryOrder: "failure_order",
				retryableFailureReasons: {
					execution: ["timeout"],
					quality: ["low_focus_confidence"],
				},
			},
			domain: {
				raman: {
					autofocus: {
						enabled: true,
						roi: { x: 100, y: 120, width: 80, height: 80 },
						params: {
							zStartUm: 260,
							zEndUm: 340,
							pointCount: 10,
							framesPerZ: 1,
							warmupFramesPerZ: 1,
						},
					},
					acquisition: {
						integrationTimeMs: 1000,
						laserPowerPercent: 0.1,
						accumulations: 1,
						timeoutMs: 30000,
						saveFormat: "txt",
					},
				},
			},
		};

		const gridScanSpec = {
			...pointListSpec,
			procedureSpecId: "proc-spec-002",
			procedureId: "raman_grid_mapping",
			plan: {
				kind: "grid_scan",
				grid: {
					origin: { xUm: 1000, yUm: 2000, zUm: 1540 },
					rows: 4,
					cols: 5,
					pitchXUm: 5,
					pitchYUm: 5,
					order: "snake",
				},
				perPoint: pointListSpec.plan.perPoint,
				interPointDelayMs: 300_000,
			},
			stoppingRules: {
				maxRuntimeMinutes: 60,
				maxUnits: 20,
				stopOnError: false,
			},
		};

		expect(ProcedureSpecValidator.Check(pointListSpec)).toBe(true);
		expect(ProcedureSpecValidator.Check(gridScanSpec)).toBe(true);
		expect(
			ProcedureSpecValidator.Check({
				...pointListSpec,
				procedureSpecId: "proc-spec-current-position",
				plan: {
					kind: "current_position",
					perPoint: [{ kind: "autofocus" }, { kind: "acquire_spectrum" }],
				},
			}),
		).toBe(true);
	});

	it("accepts a bounded Raman temperature series with configurable stability and drift policy", () => {
		const spec = {
			procedureSpecId: "proc-spec-temperature-series",
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
			plan: {
				kind: "temperature_series",
				targetsK: [200, 100],
			},
			domain: {
				raman: {
					autofocus: {
						enabled: false,
						roi: { x: 100, y: 100, width: 64, height: 64 },
					},
					acquisition: {
						integrationTimeMs: 1000,
						laserPowerPercent: 0.1,
						accumulations: 1,
					},
				},
				temperature: {
					stability: {
						toleranceK: 0.1,
						continuousHoldS: 30,
						postStableDwellS: 180,
						pollIntervalS: 1,
						timeoutPerTargetS: 1800,
					},
					driftPolicy: {
						maxDeltaK: 0.5,
						maxReacquisitionsPerTarget: 1,
						exhaustedAction: "continue",
					},
				},
			},
		};

		expect(ProcedureSpecValidator.Check(spec)).toBe(true);
		expect(ProcedureSpecValidator.Check({
			...spec,
			stoppingRules: { maxUnits: 1 },
		})).toBe(false);
		expect(ProcedureSpecValidator.Check({ ...spec, procedureId: "raman_grid_mapping" })).toBe(false);
		expect(ProcedureSpecValidator.Check({
			...spec,
			plan: { kind: "current_position", perPoint: [{ kind: "acquire_spectrum" }] },
		})).toBe(false);
		expect(ProcedureSpecValidator.Check({
			...spec,
			domain: { raman: spec.domain.raman },
		})).toBe(false);
	});

	it("rejects procedure spec shapes that are explicitly out of MVP scope", () => {
		const invalidSpec = {
			procedureSpecId: "proc-spec-003",
			experimentId: "exp-001",
			intentId: "intent-001",
			procedureId: "raman_grid_mapping",
			procedureVersion: "0.1.0",
			resources: [{ resourceId: "stage-main", role: "stage" }],
			limits: {},
			plan: {
				kind: "step_sequence",
				steps: [{ kind: "capture_frame" }],
			},
			domain: {
				raman: {
					autofocus: {
						enabled: true,
						roi: { x: 0, y: 0, width: 50, height: 50 },
					},
					acquisition: {
						integrationTimeMs: 500,
						laserPowerPercent: 0.01,
						accumulations: 1,
					},
					xyCorrection: {
						enabled: true,
					},
				},
			},
		};

		expect(ProcedureSpecValidator.Check(invalidSpec)).toBe(false);
	});

	it("rejects autofocus tolerances tighter than the MVP hardware profile", () => {
		const spec = {
			procedureSpecId: "proc-spec-tight-tolerance",
			experimentId: "exp-001",
			intentId: "intent-001",
			procedureId: "raman_single_point_probe",
			procedureVersion: "0.1.0",
			resources: [
				{ resourceId: "stage-main", role: "stage" },
				{ resourceId: "frame-main", role: "frame_provider" },
				{ resourceId: "spectrometer-main", role: "spectrometer" },
			],
			limits: {},
			plan: {
				kind: "point_list",
				points: [{ xUm: 1000, yUm: 2000, zUm: 1540 }],
				perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			},
			domain: {
				raman: {
					autofocus: {
						enabled: true,
						roi: { x: 0, y: 0, width: 50, height: 50 },
						params: {
							zStartUm: 1500,
							zEndUm: 1580,
							pointCount: 10,
							stageTimeoutMs: 3000,
							frameTimeoutMs: 500,
							settleMs: 100,
							warmupFramesPerZ: 1,
							targetToleranceUm: 1,
							finalToleranceUm: 1,
						},
					},
					acquisition: {
						integrationTimeMs: 500,
						laserPowerPercent: 0.01,
						accumulations: 1,
					},
				},
			},
		};

		expect(ProcedureSpecValidator.Check(spec)).toBe(false);
	});

	it("accepts execution units derived from semantic steps", () => {
		const unit = {
			unitId: "unit-001",
			index: 0,
			unitKind: "point",
			point: {
				row: 0,
				col: 1,
				xUm: 1000,
				yUm: 2000,
				zUm: 50,
			},
			actions: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			limits: {
				maxLaserPowerPercent: 1,
				minObjectiveClearanceUm: 200,
			},
			resumeKey: "run-001/unit-001",
			artifactScope: {
				artifactPathPrefix: "runs/run-001/unit-001",
			},
		};

		expect(ExecutionUnitValidator.Check(unit)).toBe(true);
	});

	it("accepts run state and tool result snapshots with typed artifacts and errors", () => {
		const runState = {
			runId: "run-001",
			experimentId: "exp-001",
			procedureSpecId: "proc-spec-001",
			status: "paused",
			progress: {
				completedUnits: 2,
				totalUnits: 10,
				unitKind: "point",
			},
			currentUnit: {
				unitId: "unit-003",
				index: 2,
			},
			heartbeatAt: "2026-06-29T18:00:00.000Z",
			pauseReason: "operator_requested",
			errorState: {
				errorCode: "autofocus_low_confidence",
				message: "Autofocus confidence stayed below threshold.",
				retrySafe: true,
				needsOperator: true,
				safeToResume: true,
				scope: "unit",
			},
			pointAttempts: [
				{
					pointUnitId: "unit-003",
					attemptId: "unit-003:initial:0",
					attemptIndex: 0,
					phase: "initial",
					status: "failed",
					failureType: "quality",
					failureReason: "low_focus_confidence",
					errorCode: "autofocus_low_confidence",
					finalForPoint: false,
					artifactIds: ["artifact-001"],
					timestamp: "2026-06-29T18:00:00.000Z",
				},
			],
			artifactRefs: [
				{
					artifactId: "artifact-001",
					kind: "frame",
					path: "records/run-001/frame-001.tif",
				},
			],
			startedAt: "2026-06-29T17:59:00.000Z",
			updatedAt: "2026-06-29T18:00:00.000Z",
		};

		const toolResult = {
			status: "warning",
			summary: "Run paused for operator confirmation after low-confidence autofocus.",
			runId: "run-001",
			artifactRefs: runState.artifactRefs,
			error: runState.errorState,
			details: {
				nextAction: "confirm_resume_or_abort",
			},
		};

		expect(RunStateValidator.Check(runState)).toBe(true);
		expect(ToolResultValidator.Check(toolResult)).toBe(true);
	});
});
