import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pollRun, resumeRun, startLiveRamanRun } from "../kernel/run-controller.ts";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import { summarizeProcedureProposal } from "../planner/procedure-spec-builder.ts";
import {
	clearRamanLiveRuntime, failedActionResult, registerRamanLiveRuntime, successActionResult,
	pausedActionResult, validateRuntimeAnchorState,
	type AutofocusRunSingleAction, type RamanLiveRuntime,
} from "../runtime/raman/index.ts";
import { DEFAULT_RETRY_POLICY, RunStateValidator, type ProcedureSpec, type RunState } from "../schemas/index.ts";
import { readArtifactRecords, saveFrozenProcedureSpec } from "../store/index.ts";
import { runRoot } from "../store/layout.ts";
import { writeRunStateSnapshot } from "../store/run-store.ts";
import { findProcedureProposal, hashProcedureSpec } from "../store/proposal-store.ts";
import { approveAndFreezeProcedureSpec } from "../kernel/run-admission.ts";
import { getProcedureSpecTemplateTool, runPreflightTool, validateProcedureSpecTool } from "../tools/planner.ts";
import { proposeRunTool } from "../tools/runtime.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		clearRamanLiveRuntime(root);
		rmSync(root, { recursive: true, force: true });
	}
});

function setup(failures: number, options: {
	points?: number; immediate?: number; final?: number; unsafe?: boolean;
	errorCode?: string; positionFailureReason?: string;
	moveFailures?: number[];
} = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "autofocus-retry-"));
	roots.push(cwd);
	const pointCount = options.points ?? 1;
	const spec: ProcedureSpec = {
		procedureSpecId: "spec-focus-retry", experimentId: "exp-focus-retry", intentId: "intent-focus-retry",
		procedureId: "raman_grid_mapping", procedureVersion: "0.1.0",
		resources: [{ resourceId: "stage", role: "stage" }, { resourceId: "camera", role: "frame_provider" },
			{ resourceId: "spectrum", role: "spectrometer" }],
		limits: { zRangeUm: { minUm: 2200, maxUm: 2400 }, maxLaserPowerPercent: 1 },
		plan: { kind: "point_list", points: Array.from({ length: pointCount }, (_, i) => ({ xUm: i, yUm: 0, zUm: 2300 })),
			surfaceCorrection: { kind: "disabled", reason: "user_declined" },
			perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }] },
		stoppingRules: { maxUnits: pointCount, stopOnError: true },
		retryPolicy: { ...DEFAULT_RETRY_POLICY, maxImmediateRetriesPerPoint: options.immediate ?? 1,
			maxFinalRetriesPerPoint: options.final ?? 0 },
		domain: { raman: {
			autofocus: { enabled: true, roi: { x: 0, y: 0, width: 8, height: 8 },
				params: { zStartUm: 2280, zEndUm: 2320, pointCount: 10 } },
			acquisition: { integrationTimeMs: 1000, laserPowerPercent: 0.1, accumulations: 1 },
		} },
	};
	const actions: AutofocusRunSingleAction[] = [];
	const motionX: number[] = [];
	const motionZ: number[] = [];
	let spectrumCalls = 0;
	const runtime: RamanLiveRuntime = {
		preflight: () => ({ preflightReady: true, controlAvailable: true }),
		stage: {
			resource: { resourceId: "stage", kind: "stage", runtime: "raman_python", driver: "memory",
				config: { port: "FAKE", xChannel: 1, yChannel: 2, zChannel: 3, baudrate: 115200 },
				leasePolicy: "exclusive", simulationAvailable: true,
				limits: { xRangeUm: [0, 10], yRangeUm: [0, 10], zRangeUm: [2200, 2400] } },
			getPosition: () => successActionResult("fake position", { position: { xUm: 0, yUm: 0, zUm: 2300 } }),
			moveAbsoluteAndWait: action => {
				motionX.push(action.target.xUm!);
				motionZ.push(action.target.zUm!);
				if (options.moveFailures?.includes(motionX.length)) {
					return failedActionResult("Stage did not settle within 40000 ms", {
						errorCode: "stage_move_failed", message: "Stage did not settle within 40000 ms",
						retrySafe: true, needsOperator: true, safeToResume: true,
					}, { exceptionType: "StageTimeoutError" });
				}
				return successActionResult("fake move");
			},
		},
		autofocus: { runSingle: action => {
			actions.push(action);
			if (actions.length <= failures) {
				return failedActionResult("Focus did not pass acceptance", {
					errorCode: options.errorCode ?? (options.unsafe ? "autofocus_out_of_range" : "autofocus_low_confidence"),
					message: "Focus did not pass acceptance", retrySafe: !options.unsafe,
					needsOperator: Boolean(options.unsafe), safeToResume: !options.unsafe,
				}, { zBestUm: null, confidence: 0, recommendation: "retry", positionFailureReason: options.positionFailureReason,
					confidenceDiagnostics: { qualityChecks: [{ passed: false, finalScore: 0.20488,
						bestMeasuredScore: 16.668, minimumPeakRatio: 0.7 }] } });
			}
			return successActionResult("fake focus", { zBestUm: 2301, finalScore: 12, confidence: 0.9 });
		} },
		frame: {
			resource: { resourceId: "camera", kind: "frame_provider", runtime: "raman_python", driver: "memory",
				config: { bridgeDir: "FAKE", imageFormat: "tif", minCaptureIntervalMs: 0 },
				leasePolicy: "shared-read", simulationAvailable: true },
			captureLatest: () => successActionResult("fake frame"),
		},
		spectrometer: {
			resource: { resourceId: "spectrum", kind: "spectrometer", runtime: "raman_python", driver: "memory",
				config: { bridgeDir: "FAKE", requestFilename: "request", resultFilename: "result" },
				leasePolicy: "exclusive", simulationAvailable: true },
			acquireSpectrum: () => {
				spectrumCalls += 1;
				return successActionResult("fake spectrum", { saturated: false, snr: 20, targetPeakBaselineRatio: 5 });
			},
		},
	};
	registerRamanLiveRuntime(cwd, runtime);
	return { cwd, spec, runtime, actions, motionX, motionZ, spectrumCalls: () => spectrumCalls };
}

async function finish(cwd: string, runId: string): Promise<RunState> {
	let state: RunState | undefined;
	await expect.poll(() => {
		state = pollRun(cwd, runId);
		return state?.status;
	}).toMatch(/^(completed|failed|paused|aborted)$/u);
	return state!;
}

describe("autofocus quality failure uses the existing mapping retry policy", () => {
	it.each(["point_list", "grid_scan", "line"] as const)("accepts default %s mapping through approval and focuses XY-only points from measured Z", async shape => {
		const run = setup(0, { points: 2 });
		const perPoint = run.spec.plan.perPoint;
		run.spec.plan = shape === "grid_scan"
			? { kind: "grid_scan", grid: { origin: { xUm: 0, yUm: 0 }, rows: 1, cols: 2, pitchXUm: 1, pitchYUm: 1 }, perPoint }
			: shape === "line"
				? { kind: "point_list", generator: { kind: "line", from: { xUm: 0, yUm: 0 }, to: { xUm: 1, yUm: 0 }, count: 2 }, perPoint }
				: { kind: "point_list", points: [{ xUm: 0, yUm: 0 }, { xUm: 1, yUm: 0 }], perPoint };
		run.runtime.stage.getPosition = () => successActionResult("position", { position: { xUm: 0, yUm: 0, zUm: 2310 } });
		const context = { cwd: run.cwd } as never;
		const validated = await validateProcedureSpecTool.execute("validate-default", { spec: run.spec });
		expect(validated.details.status).toBe("success");
		const preflight = await runPreflightTool.execute("preflight-default", { spec: run.spec, executionMode: "live-supervised" }, undefined, undefined, context);
		expect(preflight.details.stateAfter.readyForApproval).toBe(true);
		expect(run.motionZ).toEqual([]);
		const proposed = await proposeRunTool.execute("propose-default", { spec: run.spec }, undefined, undefined, context);
		expect(proposed.details.status).toBe("success");
		const proposal = findProcedureProposal(run.cwd, proposed.details.stateAfter.proposalId as string)!;
		expect(proposal.spec.plan).toMatchObject({ surfaceCorrection: { kind: "disabled", reason: "default_disabled" } });
		expect(proposal.specHash).toBe(hashProcedureSpec(proposal.spec));
		expect(proposal.specHash).not.toBe(hashProcedureSpec(run.spec));
		expect(run.spec.plan.surfaceCorrection).toBeUndefined();
		const preview = summarizeProcedureProposal(proposal.spec);
		expect(preview.risks.find(r => r.code === "focus_plane_correction_disabled_by_default")?.level).toBe("notice");
		const admission = { cwd: run.cwd, proposalId: proposal.proposalId, specHash: proposal.specHash,
			mode: "live-supervised" as const, admission: { preflightReady: true, controlAvailable: true } };
		expect(() => approveAndFreezeProcedureSpec(admission)).toThrow(/explicit user approval/u);
		const { frozenSpec } = approveAndFreezeProcedureSpec({ ...admission, operatorApproval: {
			acknowledgedProposalId: proposal.proposalId, acknowledgedSpecHash: proposal.specHash,
			approvedBy: "user", approvedAt: "2026-11-13T00:00:00.000Z",
		} });
		const initial = startLiveRamanRun(run.cwd, frozenSpec);
		expect((await finish(run.cwd, initial.runId)).status).toBe("completed");
		expect(run.motionZ).toEqual([2310, 2301]);
		expect(run.actions.map(a => [a.params?.zStartUm, a.params?.zEndUm])).toEqual([[2290, 2330], [2281, 2321]]);
	});

	it("returns an executable default Mapping template without calibration placeholders", async () => {
		const result = await getProcedureSpecTemplateTool.execute("template-default", { procedureId: "raman_grid_mapping" });
		const spec = result.details.stateAfter.template as ProcedureSpec;
		expect(spec.plan).toMatchObject({ surfaceCorrection: { kind: "disabled", reason: "default_disabled" } });
		expect(JSON.stringify(spec)).not.toContain("replace-with-focus-plane");
		expect((await validateProcedureSpecTool.execute("validate-template", { spec })).details.status).toBe("success");
		expect(compileProcedureSpec(spec)).toHaveLength(256);
	});

	it("still rejects an invalid explicitly enabled focus plane before proposal approval", async () => {
		const run = setup(0);
		if (run.spec.plan.kind !== "point_list") throw new Error("expected point list");
		run.spec.plan.surfaceCorrection = { kind: "focus_plane" } as never;
		expect((await validateProcedureSpecTool.execute("invalid-plane", { spec: run.spec })).details.status).toBe("error");
		expect((await proposeRunTool.execute("invalid-plane", { spec: run.spec }, undefined, undefined, { cwd: run.cwd } as never)).details.status).toBe("error");
		expect(run.motionZ).toEqual([]);
	});

	it("seeds from measured Z before motion, then follows accepted focus instead of planned Z", async () => {
		const run = setup(0, { points: 2 });
		let reads = 0;
		run.runtime.stage.getPosition = () => {
			reads += 1;
			expect(run.motionX).toEqual([]);
			return successActionResult("position", { position: { xUm: 0, yUm: 0, zUm: 2310 } });
		};
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(reads).toBe(1);
		expect(run.motionZ).toEqual([2310, 2301]);
		expect(run.actions.map(a => [a.params?.zStartUm, a.params?.zEndUm])).toEqual([[2290, 2330], [2281, 2321]]);
		expect(state.initialFocusZUm).toBe(2310);
		expect(state.focusCenterPolicy).toBe("previous_successful_then_initial_position");
		expect(Object.values(state.mappingFocusWindows!).map(w => w.source)).toEqual(["initial_position", "previous_accepted_focus"]);
		expect(RunStateValidator.Check(state)).toBe(true);
	});

	it("retains the initial seed when a failed scan leaves the stage at a different Z", async () => {
		const run = setup(1);
		let reads = 0;
		run.runtime.stage.getPosition = () => successActionResult("position", {
			position: { xUm: 0, yUm: 0, zUm: ++reads === 1 ? 2310 : 2380 },
		});
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(reads).toBe(1);
		expect(run.motionZ).toEqual([2310, 2310]);
		expect(run.actions.map(a => a.params?.zStartUm)).toEqual([2290, 2290]);
	});

	it("uses the saved point window for a final retry after later points have focused", async () => {
		const run = setup(1, { points: 2, immediate: 0, final: 1 });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(run.motionX).toEqual([0, 1, 0]);
		expect(run.actions.map(a => [a.params?.zStartUm, a.params?.zEndUm])).toEqual([
			[2280, 2320], [2280, 2320], [2280, 2320],
		]);
	});

	it("recovers the saved seed and window across pause/resume without reading a new initial Z", async () => {
		const run = setup(0);
		saveFrozenProcedureSpec(run.cwd, run.spec);
		const focus = run.runtime.autofocus.runSingle;
		let calls = 0;
		run.runtime.autofocus.runSingle = action => ++calls === 1 ? pausedActionResult("pause") : focus(action);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const paused = await finish(run.cwd, initial.runId);
		expect(paused.status).toBe("paused");
		expect(paused.initialFocusZUm).toBe(2300);
		run.runtime.stage.getPosition = () => { throw new Error("must use persisted initial Z"); };
		resumeRun(run.cwd, initial.runId);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(run.actions[0]?.params?.zStartUm).toBe(2280);
		expect(run.motionZ).toEqual([2300, 2300]);
	});

	it.each([2390, Number.NaN, Number.POSITIVE_INFINITY])("rejects an unsafe or invalid initial Z %s before motion", async zUm => {
		const run = setup(0);
		run.runtime.stage.getPosition = () => successActionResult("position", { position: { xUm: 0, yUm: 0, zUm } });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(run.motionX).toEqual([]);
		expect(run.actions).toEqual([]);
	});

	it("does not retry an initial position timeout with a potentially different seed", async () => {
		const run = setup(0);
		let reads = 0;
		run.runtime.stage.getPosition = () => {
			reads += 1;
			return failedActionResult("position timeout", {
				errorCode: "stage_timeout", message: "position timeout", retrySafe: true,
				needsOperator: false, safeToResume: true,
			});
		};
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(state.errorState?.errorCode).toBe("autofocus_initial_position_read_failed");
		expect(reads).toBe(1);
		expect(run.motionX).toEqual([]);
	});

	it("refuses to recenter a legacy resumed run without saved initial-position evidence", async () => {
		const run = setup(0, { points: 2 });
		saveFrozenProcedureSpec(run.cwd, run.spec);
		const focus = run.runtime.autofocus.runSingle;
		let calls = 0;
		run.runtime.autofocus.runSingle = action => ++calls === 2 ? pausedActionResult("pause") : focus(action);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const paused = await finish(run.cwd, initial.runId);
		expect(paused.status).toBe("paused");
		expect(paused.lastAcceptedFocusZUm).toBe(2301);
		delete paused.initialFocusZUm;
		delete paused.mappingFocusWindows;
		writeRunStateSnapshot(run.cwd, paused);
		run.runtime.stage.getPosition = () => { throw new Error("must not invent a legacy seed"); };
		resumeRun(run.cwd, initial.runId);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(state.errorState?.errorCode).toBe("autofocus_initial_position_missing");
		expect(run.motionZ).toEqual([2300, 2301]);
	});

	it("checks resource limits even when the spec permits a wider Z range", async () => {
		const run = setup(0);
		run.spec.limits.zRangeUm = { minUm: 2100, maxUm: 2500 };
		run.runtime.stage.getPosition = () => successActionResult("position", { position: { xUm: 0, yUm: 0, zUm: 2390 } });
		const preflight = await validateRuntimeAnchorState(run.spec, run.runtime);
		expect(preflight.valid).toBe(false);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		expect((await finish(run.cwd, initial.runId)).status).toBe("failed");
		expect(run.motionX).toEqual([]);
	});

	it("preflights the measured center and presents the new policy even when planned Z is at the old boundary", async () => {
		const run = setup(0);
		if (run.spec.plan.kind !== "point_list") throw new Error("expected point list");
		run.spec.plan.points![0]!.zUm = 2395;
		expect(compileProcedureSpec(run.spec)).toHaveLength(1);
		const preview = summarizeProcedureProposal(run.spec);
		expect(preview.risks.find(r => r.code === "focus_plane_correction_declined")?.message).toContain("measured Z before the first move");
		const preflight = await validateRuntimeAnchorState(run.spec, run.runtime);
		expect(preflight.valid).toBe(true);
		expect(preflight.details.initialFocusZUm).toBe(2300);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		expect((await finish(run.cwd, initial.runId)).status).toBe("completed");
		expect(run.motionZ).toEqual([2300]);
	});

	it("keeps explicit fixed_absolute mapping on its declared range", async () => {
		const run = setup(0);
		run.spec.domain.raman.autofocus.params!.strategy = "fixed_absolute";
		run.runtime.stage.getPosition = () => { throw new Error("fixed range has no initial seed read"); };
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(state.initialFocusZUm).toBeUndefined();
		expect(run.actions[0]?.params?.zStartUm).toBe(2280);
	});

	it("retries before the next point, keeps its range, skips failed acquisition and preserves attempt evidence", async () => {
		const run = setup(1, { points: 2 });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(run.motionX).toEqual([0, 0, 1]);
		expect(run.actions.map(a => [a.params?.zStartUm, a.params?.zEndUm])).toEqual([
			[2280, 2320], [2280, 2320], [2281, 2321],
		]);
		expect(run.spectrumCalls()).toBe(2);
		expect(state.pointAttempts?.map(a => [a.phase, a.status])).toEqual([
			["initial", "failed"], ["immediate_retry", "succeeded"], ["initial", "succeeded"],
		]);
		const records = readArtifactRecords(run.cwd, initial.runId).filter(r => r.artifact.kind === "raman-autofocus");
		expect(new Set(records.map(r => r.artifact.artifactId)).size).toBe(3);
		expect(new Set(records.map(r => r.artifact.path)).size).toBe(3);
		const attempts = records.map(r => JSON.parse(readFileSync(join(runRoot(run.cwd, initial.runId), r.artifact.path), "utf8")));
		expect(attempts.map(a => a.status)).toEqual(["failed", "success", "success"]);
		expect(attempts[0].payload.confidenceDiagnostics.qualityChecks[0].finalScore).toBe(0.20488);
		expect(attempts[1].autofocusAttemptNumber).toBe(2);
		expect(state.lastAcceptedFocusZUm).toBe(2301);
	});

	it.each([
		{ label: "exhausts the one immediate retry", immediate: 1, unsafe: false, calls: 2 },
		{ label: "honors an explicitly disabled retry", immediate: 0, unsafe: false, calls: 1 },
		{ label: "never retries an out-of-range focus", immediate: 1, unsafe: true, calls: 1 },
	])("$label", async ({ immediate, unsafe, calls }) => {
		const run = setup(10, { immediate, unsafe });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(run.actions).toHaveLength(calls);
		expect(run.spectrumCalls()).toBe(0);
		expect(state.lastAcceptedFocusZUm).toBeUndefined();
	});

	it("preserves a separately configured final retry", async () => {
		const run = setup(1, { immediate: 0, final: 1 });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(state.pointAttempts?.map(a => a.phase)).toEqual(["initial", "final_retry"]);
		expect(run.actions).toHaveLength(2);
	});

	it.each(["read_timeout", "target_mismatch", "capture_displacement"])(
		"remeasures the whole XY point for %s with its original window and legacy retry budget", async positionFailureReason => {
			const run = setup(1, { points: 2, errorCode: "autofocus_position_feedback", positionFailureReason });
			run.spec.retryPolicy!.retryableFailureReasons = { execution: ["timeout"], quality: ["low_focus_confidence"] };
			const initial = startLiveRamanRun(run.cwd, run.spec);
			const state = await finish(run.cwd, initial.runId);
			expect(state.status).toBe("completed");
			expect(run.motionX).toEqual([0, 0, 1]);
			expect(run.motionZ).toEqual([2300, 2300, 2301]);
			expect(run.actions.map(a => [a.params?.zStartUm, a.params?.zEndUm])).toEqual([
				[2280, 2320], [2280, 2320], [2281, 2321],
			]);
			expect(run.spectrumCalls()).toBe(2);
			expect(state.pointAttempts?.map(a => [a.phase, a.status])).toEqual([
				["initial", "failed"], ["immediate_retry", "succeeded"], ["initial", "succeeded"],
			]);
			expect(state.pointAttempts?.[0]).toMatchObject({
				failureType: "execution", failureReason: "position_feedback", errorCode: "autofocus_position_feedback",
			});
			expect(RunStateValidator.Check(state)).toBe(true);
			const records = readArtifactRecords(run.cwd, initial.runId).filter(r => r.artifact.kind === "raman-autofocus");
			expect(new Set(records.map(r => r.artifact.path)).size).toBe(3);
			const failed = JSON.parse(readFileSync(join(runRoot(run.cwd, initial.runId), records[0]!.artifact.path), "utf8"));
			expect(failed.payload.positionFailureReason).toBe(positionFailureReason);
		},
	);

	it.each([
		{ label: "stops when retries are exhausted", immediate: 1, unsafe: false, errorCode: "autofocus_position_feedback", calls: 2 },
		{ label: "honors zero retries", immediate: 0, unsafe: false, errorCode: "autofocus_position_feedback", calls: 1 },
		{ label: "does not retry unsafe position failures", immediate: 1, unsafe: true, errorCode: "autofocus_position_feedback", calls: 1 },
		{ label: "does not classify generic stage errors as position failures", immediate: 1, unsafe: false, errorCode: "autofocus_stage_error", calls: 1 },
	])("position remeasurement $label", async ({ immediate, unsafe, errorCode, calls }) => {
		const run = setup(10, { immediate, unsafe, errorCode, positionFailureReason: "target_mismatch" });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(run.actions).toHaveLength(calls);
		expect(run.spectrumCalls()).toBe(0);
		expect(state.lastAcceptedFocusZUm).toBeUndefined();
	});

	it("keeps the failed position's original window for a configured final retry", async () => {
		const run = setup(1, { points: 2, immediate: 0, final: 1,
			errorCode: "autofocus_position_feedback", positionFailureReason: "capture_displacement" });
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(run.motionX).toEqual([0, 1, 0]);
		expect(run.motionZ).toEqual([2300, 2300, 2300]);
		expect(run.actions.map(a => [a.params?.zStartUm, a.params?.zEndUm])).toEqual([
			[2280, 2320], [2280, 2320], [2280, 2320],
		]);
		expect(state.pointAttempts?.map(a => a.phase)).toEqual(["initial", "initial", "final_retry"]);
	});

	it("retries a position read timeout during placement before starting the point's autofocus", async () => {
		const run = setup(0);
		const move = run.runtime.stage.moveAbsoluteAndWait;
		let calls = 0;
		run.runtime.stage.moveAbsoluteAndWait = action => ++calls === 1 ? failedActionResult("position read timeout", {
			errorCode: "stage_position_feedback", message: "position read timeout", retrySafe: true,
			needsOperator: false, safeToResume: true,
		}, { exceptionType: "StagePositionReadTimeoutError", positionFailureReason: "read_timeout" }) : move(action);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(calls).toBe(2);
		expect(run.actions).toHaveLength(1);
		expect(state.pointAttempts?.map(a => a.phase)).toEqual(["initial", "immediate_retry"]);
		expect(run.spectrumCalls()).toBe(1);
	});

	it.each([
		{ label: "movement failure then focus failure", moveFailures: [1], focusFailures: 1, immediate: 1, final: 0,
			status: "completed", moves: 3, focuses: 2, stages: ["move", "autofocus"] },
		{ label: "focus failure then movement failure", moveFailures: [2], focusFailures: 1, immediate: 1, final: 0,
			status: "completed", moves: 3, focuses: 2, stages: ["autofocus", "move"] },
		{ label: "movement quota stays spent after a focus failure", moveFailures: [1, 3], focusFailures: 1, immediate: 1, final: 0,
			status: "failed", moves: 3, focuses: 1, stages: ["move", "autofocus"] },
		{ label: "focus quota stays bounded after a movement failure", moveFailures: [1], focusFailures: 2, immediate: 1, final: 0,
			status: "failed", moves: 3, focuses: 2, stages: ["move", "autofocus"] },
		{ label: "unused focus quota cannot extend repeated movement failures", moveFailures: [1, 2], focusFailures: 0, immediate: 1, final: 0,
			status: "failed", moves: 2, focuses: 0, stages: ["move"] },
		{ label: "explicit zero disables movement retries too", moveFailures: [1], focusFailures: 1, immediate: 0, final: 0,
			status: "failed", moves: 1, focuses: 0, stages: [] },
		{ label: "configured final retries are independent too", moveFailures: [1], focusFailures: 1, immediate: 0, final: 1,
			status: "completed", moves: 3, focuses: 2, stages: ["move", "autofocus"] },
		{ label: "final movement quota cannot reset after focus failure", moveFailures: [1, 3], focusFailures: 1, immediate: 0, final: 1,
			status: "failed", moves: 3, focuses: 1, stages: ["move", "autofocus"] },
		{ label: "configured two retries apply to each stage", moveFailures: [1, 2], focusFailures: 2, immediate: 2, final: 0,
			status: "completed", moves: 5, focuses: 3, stages: ["move", "move", "autofocus", "autofocus"] },
	])("keeps separate budgets: $label", async options => {
		const run = setup(options.focusFailures, options);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe(options.status);
		expect(run.motionX).toHaveLength(options.moves);
		expect(run.actions).toHaveLength(options.focuses);
		expect(run.spectrumCalls()).toBe(options.status === "completed" ? 1 : 0);
		expect(state.pointAttempts?.flatMap(a => a.scheduledRetry ? [a.scheduledRetry.stage] : [])).toEqual(options.stages);
		expect(state.pointAttempts?.map(a => a.attemptIndex)).toEqual(Array.from({ length: options.moves }, (_, i) => i));
		expect(state.pointAttempts?.filter(a => a.finalForPoint)).toHaveLength(1);
		expect(run.actions.every(a => a.params?.zStartUm === 2280 && a.params?.zEndUm === 2320)).toBe(true);
		expect(RunStateValidator.Check(state)).toBe(true);
	});

	it("counts autofocus feedback and quality failures against the same autofocus budget", async () => {
		const options = { errorCode: "autofocus_position_feedback" };
		const run = setup(2, options);
		const focus = run.runtime.autofocus.runSingle;
		run.runtime.autofocus.runSingle = action => {
			if (run.actions.length === 1) options.errorCode = "autofocus_low_confidence";
			return focus(action);
		};
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(run.actions).toHaveLength(2);
		expect(state.pointAttempts?.map(a => a.errorCode)).toEqual(["autofocus_position_feedback", "autofocus_low_confidence"]);
	});

	it.each([false, true])("preserves spent budgets and unique attempt IDs across pause/resume (legacy=%s)", async legacy => {
		const run = setup(1, { moveFailures: [1, 3] });
		saveFrozenProcedureSpec(run.cwd, run.spec);
		const move = run.runtime.stage.moveAbsoluteAndWait;
		let calls = 0;
		run.runtime.stage.moveAbsoluteAndWait = action => ++calls === 3 ? pausedActionResult("pause before retry") : move(action);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		const paused = await finish(run.cwd, initial.runId);
		expect(paused.status).toBe("paused");
		expect(paused.pointAttempts?.map(a => a.scheduledRetry?.stage)).toEqual(["move", "autofocus"]);
		if (legacy) {
			// Legacy snapshots can contain the first scheduled movement retry only;
			// the second record already needs the new independent-budget semantics.
			delete paused.pointAttempts![0]!.scheduledRetry;
			writeRunStateSnapshot(run.cwd, paused);
		}
		resumeRun(run.cwd, initial.runId);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("failed");
		expect(calls).toBe(4);
		expect(state.pointAttempts?.map(a => a.attemptIndex)).toEqual([0, 1, 2]);
		expect(new Set(state.pointAttempts?.map(a => a.attemptId)).size).toBe(3);
		expect(state.pointAttempts?.at(-1)?.errorCode).toBe("stage_move_failed");
		expect(run.spectrumCalls()).toBe(0);
	});

	it("restores an earlier point's queued final retry after a later point pauses", async () => {
		const run = setup(1, { points: 2, immediate: 0, final: 1 });
		saveFrozenProcedureSpec(run.cwd, run.spec);
		const move = run.runtime.stage.moveAbsoluteAndWait;
		let calls = 0;
		run.runtime.stage.moveAbsoluteAndWait = action => ++calls === 2 ? pausedActionResult("pause next point") : move(action);
		const initial = startLiveRamanRun(run.cwd, run.spec);
		expect((await finish(run.cwd, initial.runId)).status).toBe("paused");
		resumeRun(run.cwd, initial.runId);
		const state = await finish(run.cwd, initial.runId);
		expect(state.status).toBe("completed");
		expect(state.progress.completedUnits).toBe(2);
		expect(run.motionX).toEqual([0, 1, 0]);
		expect(state.pointAttempts?.map(a => a.phase)).toEqual(["initial", "initial", "final_retry"]);
	});
});
