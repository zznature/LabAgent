import { randomUUID } from "node:crypto";
import type {
	ExecutionUnit,
	PointAttemptRecord,
	ProcedureSpec,
	RunState,
	RuntimeError,
} from "../schemas/index.ts";
import { appendRunEvent, type RunEvent } from "../store/event-store.ts";
import { readProcedureSpec } from "../store/procedure-spec-store.ts";
import { readRunStateSnapshot, writeRunStateSnapshot } from "../store/run-store.ts";
import {
	getRamanLiveRuntime,
	runLiveRamanUnit,
	type LiveRamanUnitOptions,
	type LiveRamanUnitResult,
} from "../runtime/raman/index.ts";
import {
	runSimulationUnit,
	type SimulationControls,
	type SimulationUnitResult,
} from "../runtime/simulation-runtime.ts";
import { compileProcedureSpec } from "./compile-units.ts";
import { executeLinearRun, executeMappingRun, executeParameterSearchRun } from "./run-strategies.ts";

type ExecutionMode = "simulation" | "live-supervised";
export type ManagedUnitResult = SimulationUnitResult | LiveRamanUnitResult;

export interface UnitAttemptContext {
	attemptIndex: number;
	phase: PointAttemptRecord["phase"];
}

export interface ActiveRun {
	runId: string;
	cwd: string;
	spec: ProcedureSpec;
	units: ExecutionUnit[];
	mode: ExecutionMode;
	/** First unit index this execution should attempt; non-zero only on resume. */
	startIndex: number;
	controls?: SimulationControls;
	pauseRequested: boolean;
	abortRequested: boolean;
	promise: Promise<void>;
}

export interface RunExecutionContext {
	activeRun: ActiveRun;
	start(): void;
	abortAt(unit: ExecutionUnit): void;
	markUnitStarted(unit: ExecutionUnit, attempt?: UnitAttemptContext): RunState;
	executeUnit(unit: ExecutionUnit, options?: LiveRamanUnitOptions): Promise<ManagedUnitResult>;
	waitAfterUnit(unit: ExecutionUnit): Promise<"continue" | "paused" | "aborted">;
	pause(unit: ExecutionUnit, reason: string, resultArtifacts: RunState["artifactRefs"]): void;
	fail(unit: ExecutionUnit, failure: RuntimeError, resultArtifacts: RunState["artifactRefs"]): void;
	complete(): void;
	completeUnit(
		unit: ExecutionUnit,
		resultArtifacts: RunState["artifactRefs"],
		additionalPayload?: Record<string, unknown>,
		attempt?: UnitAttemptContext,
	): void;
	recordUnitFailureAndContinue(
		unit: ExecutionUnit,
		failure: RuntimeError,
		resultArtifacts: RunState["artifactRefs"],
		attempt?: UnitAttemptContext,
	): void;
	recordPointAttempt(record: Omit<PointAttemptRecord, "timestamp">): void;
}

const activeRuns = new Map<string, ActiveRun>();

/**
 * Observer notified once per run terminal transition (paused / failed / completed / aborted).
 * The extension host uses it to push run outcomes instead of making the operator poll.
 * Progress transitions are deliberately not reported: a mapping run would interrupt the
 * agent at every point.
 */
export type RunTerminalObserver = (runState: RunState) => void;

let runTerminalObserver: RunTerminalObserver | undefined;

export function setRunTerminalObserver(observer: RunTerminalObserver | undefined): void {
	runTerminalObserver = observer;
}

function notifyRunTerminal(cwd: string, runId: string): void {
	if (!runTerminalObserver) {
		return;
	}
	const runState = readRunStateSnapshot(cwd, runId);
	if (!runState) {
		return;
	}
	try {
		runTerminalObserver(runState);
	} catch {
		// A failing observer must never corrupt run bookkeeping.
	}
}

const DEFAULT_MAPPING_MAX_CONSECUTIVE_FAILURES = 3;
const INTER_UNIT_DELAY_HEARTBEAT_MS = 1_000;

function timestamp(): string {
	return new Date().toISOString();
}

function appendEvent(cwd: string, event: RunEvent): void {
	appendRunEvent(cwd, event);
}

function isParameterSearchRun(spec: ProcedureSpec): boolean {
	return spec.procedureId === "raman_parameter_search";
}

function maxUnitsForSpec(spec: ProcedureSpec, units: ExecutionUnit[]): number {
	const stoppingMaxUnits = spec.stoppingRules?.maxUnits ?? units.length;
	if (!isParameterSearchRun(spec)) {
		return Math.min(units.length, stoppingMaxUnits);
	}

	const maxAttempts = spec.domain.raman.parameterSearch?.maxAttempts ?? units.length;
	return Math.min(units.length, stoppingMaxUnits, maxAttempts);
}

function limitedUnitsForSpec(spec: ProcedureSpec, units: ExecutionUnit[]): ExecutionUnit[] {
	return units.slice(0, maxUnitsForSpec(spec, units));
}

function createBaseRunState(runId: string, spec: ProcedureSpec, units: ExecutionUnit[], mode: ExecutionMode): RunState {
	const now = timestamp();
	return {
		runId,
		experimentId: spec.experimentId,
		procedureSpecId: spec.procedureSpecId,
		executionMode: mode,
		status: "queued",
		progress: {
			completedUnits: 0,
			failedUnits: 0,
			totalUnits: units.length,
			unitKind: units[0]?.unitKind ?? "point",
		},
		artifactRefs: [],
		pointAttempts: [],
		startedAt: now,
		updatedAt: now,
	};
}

function setRunState(cwd: string, runState: RunState): RunState {
	writeRunStateSnapshot(cwd, runState);
	return runState;
}

function updateRunState(cwd: string, runId: string, updater: (current: RunState) => RunState): RunState {
	const current = readRunStateSnapshot(cwd, runId);
	if (!current) {
		throw new Error(`run not found: ${runId}`);
	}
	return setRunState(cwd, updater(current));
}

async function executeUnit(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	currentState: RunState,
	options?: LiveRamanUnitOptions,
): Promise<ManagedUnitResult> {
	if (activeRun.mode === "simulation") {
		return runSimulationUnit(activeRun.cwd, activeRun.runId, unit, activeRun.spec, activeRun.controls ?? {}, currentState);
	}

	const runtime = getRamanLiveRuntime(activeRun.cwd);
	if (!runtime) {
		throw new Error(`live Raman runtime not registered for cwd ${activeRun.cwd}`);
	}

	return runLiveRamanUnit(activeRun.cwd, activeRun.runId, unit, activeRun.spec, runtime, currentState, options);
}

function appendRunStartedEvent(activeRun: ActiveRun): void {
	appendEvent(activeRun.cwd, {
		eventId: activeRun.startIndex > 0 ? `${activeRun.runId}-resumed-${activeRun.startIndex}` : `${activeRun.runId}-started`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "run_started",
		timestamp: timestamp(),
		payload: {
			totalUnits: activeRun.units.length,
			mode: activeRun.mode,
			startIndex: activeRun.startIndex,
		},
	});
}

function attemptEventSuffix(attempt?: UnitAttemptContext): string {
	return attempt ? `${attempt.phase}-${attempt.attemptIndex}` : "initial";
}

function attemptPayload(attempt?: UnitAttemptContext): Record<string, unknown> {
	return attempt ? { attemptIndex: attempt.attemptIndex, phase: attempt.phase } : {};
}

function appendUnitStartedEvent(activeRun: ActiveRun, unit: ExecutionUnit, attempt?: UnitAttemptContext): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-unit-start-${unit.index}-${attemptEventSuffix(attempt)}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "unit_started",
		timestamp: timestamp(),
		payload: { unitId: unit.unitId, index: unit.index, ...attemptPayload(attempt) },
	});
}

function appendUnitCompletedEvent(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	artifacts: RunState["artifactRefs"],
	additionalPayload: Record<string, unknown> = {},
	attempt?: UnitAttemptContext,
): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-unit-complete-${unit.index}-${attemptEventSuffix(attempt)}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "unit_completed",
		timestamp: timestamp(),
		payload: {
			unitId: unit.unitId,
			index: unit.index,
			artifacts: artifacts.map((artifact) => artifact.artifactId),
			...attemptPayload(attempt),
			...additionalPayload,
		},
	});
}

function appendInterUnitDelayEvent(activeRun: ActiveRun, unit: ExecutionUnit, delayMs: number): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-inter-unit-delay-${unit.index}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "inter_unit_delay_started",
		timestamp: timestamp(),
		payload: {
			unitId: unit.unitId,
			index: unit.index,
			delayMs,
		},
	});
}

function appendUnitFailedEvent(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	failure: RuntimeError,
	artifacts: RunState["artifactRefs"],
	attempt?: UnitAttemptContext,
): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-failed-${unit.index}-${attemptEventSuffix(attempt)}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "unit_failed",
		timestamp: timestamp(),
		payload: {
			unitId: unit.unitId,
			index: unit.index,
			unitKind: unit.unitKind,
			positionRef: unit.positionRef,
			point: unit.point,
			actions: unit.actions,
			...attemptPayload(attempt),
			errorCode: failure.errorCode,
			message: failure.message,
			retrySafe: failure.retrySafe,
			needsOperator: failure.needsOperator,
			safeToResume: failure.safeToResume,
			scope: failure.scope,
			error: failure,
			diagnostics: failure.payload ?? {},
			artifacts: artifacts.map((artifact) => artifact.artifactId),
		},
	});
}

function pauseActiveRun(activeRun: ActiveRun, unit: ExecutionUnit, reason: string, resultArtifacts: RunState["artifactRefs"]): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "paused",
		pauseReason: reason,
		artifactRefs: current.artifactRefs.concat(resultArtifacts),
		updatedAt: timestamp(),
	}));
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-paused-${unit.index}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "run_paused",
		timestamp: timestamp(),
		payload: {
			unitId: unit.unitId,
			index: unit.index,
			artifacts: resultArtifacts.map((artifact) => artifact.artifactId),
		},
	});
	activeRuns.delete(activeRun.runId);
	notifyRunTerminal(activeRun.cwd, activeRun.runId);
}

function failActiveRun(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	failure: RuntimeError,
	resultArtifacts: RunState["artifactRefs"],
): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "failed",
		errorState: failure,
		artifactRefs: current.artifactRefs.concat(resultArtifacts),
		updatedAt: timestamp(),
		endedAt: timestamp(),
	}));
	appendUnitFailedEvent(activeRun, unit, failure, resultArtifacts);
	activeRuns.delete(activeRun.runId);
	notifyRunTerminal(activeRun.cwd, activeRun.runId);
}

function completeActiveRun(activeRun: ActiveRun): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "completed",
		qualityState: (current.progress.failedUnits ?? 0) > 0 ? "completed_with_failures" : "completed",
		currentUnit: undefined,
		updatedAt: timestamp(),
		endedAt: timestamp(),
	}));
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-completed`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "run_completed",
		timestamp: timestamp(),
		payload: {
			completedUnits: readRunStateSnapshot(activeRun.cwd, activeRun.runId)?.progress.completedUnits ?? activeRun.units.length,
			failedUnits: readRunStateSnapshot(activeRun.cwd, activeRun.runId)?.progress.failedUnits ?? 0,
			qualityState: readRunStateSnapshot(activeRun.cwd, activeRun.runId)?.qualityState ?? "completed",
		},
	});
	activeRuns.delete(activeRun.runId);
	notifyRunTerminal(activeRun.cwd, activeRun.runId);
}

function applyCompletedProgress(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	resultArtifacts: RunState["artifactRefs"],
	additionalPayload: Record<string, unknown> = {},
	attempt?: UnitAttemptContext,
): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "running",
		progress: {
			...current.progress,
			completedUnits: current.progress.completedUnits + 1,
		},
		currentUnit: { unitId: unit.unitId, index: unit.index },
		artifactRefs: current.artifactRefs.concat(resultArtifacts),
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	}));
	appendUnitCompletedEvent(activeRun, unit, resultArtifacts, additionalPayload, attempt);
}

function applySkippedFailureProgress(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	failure: RuntimeError,
	resultArtifacts: RunState["artifactRefs"],
	attempt?: UnitAttemptContext,
): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "running",
		progress: {
			...current.progress,
			failedUnits: (current.progress.failedUnits ?? 0) + 1,
		},
		currentUnit: { unitId: unit.unitId, index: unit.index },
		artifactRefs: current.artifactRefs.concat(resultArtifacts),
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	}));
	appendUnitFailedEvent(activeRun, unit, failure, resultArtifacts, attempt);
}

function refreshHeartbeat(activeRun: ActiveRun): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	}));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitAfterUnitBoundary(activeRun: ActiveRun, unit: ExecutionUnit): Promise<"continue" | "paused" | "aborted"> {
	const delayMs = unit.interUnitDelayMs ?? 0;
	if (delayMs <= 0) {
		return "continue";
	}

	appendInterUnitDelayEvent(activeRun, unit, delayMs);
	const deadline = Date.now() + delayMs;
	while (Date.now() < deadline) {
		if (activeRun.abortRequested) {
			abortActiveRun(activeRun, unit);
			return "aborted";
		}
		if (activeRun.pauseRequested) {
			pauseActiveRun(activeRun, unit, "operator_requested_during_inter_unit_delay", []);
			return "paused";
		}
		refreshHeartbeat(activeRun);
		await sleep(Math.min(INTER_UNIT_DELAY_HEARTBEAT_MS, Math.max(0, deadline - Date.now())));
	}

	return "continue";
}

function singlePointOptions(activeRun: ActiveRun): LiveRamanUnitOptions | undefined {
	if (activeRun.mode !== "live-supervised") {
		return undefined;
	}
	return {
		evaluation: {
			attemptIndex: 0,
			recentObservations: [],
			singlePointAcceptance: true,
		},
	};
}

function startActiveRun(activeRun: ActiveRun): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "running",
		updatedAt: timestamp(),
		heartbeatAt: timestamp(),
	}));
	appendRunStartedEvent(activeRun);
}

function abortActiveRun(activeRun: ActiveRun, unit: ExecutionUnit): void {
	updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "aborted",
		abortReason: "operator_requested",
		updatedAt: timestamp(),
		endedAt: timestamp(),
	}));
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-aborted-${unit.index}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "run_aborted",
		timestamp: timestamp(),
		payload: { unitId: unit.unitId, index: unit.index },
	});
	activeRuns.delete(activeRun.runId);
	notifyRunTerminal(activeRun.cwd, activeRun.runId);
}

function markActiveUnitStarted(activeRun: ActiveRun, unit: ExecutionUnit, attempt?: UnitAttemptContext): RunState {
	appendUnitStartedEvent(activeRun, unit, attempt);
	return updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
		...current,
		status: "running",
		currentUnit: { unitId: unit.unitId, index: unit.index },
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	}));
}

function createRunExecutionContext(activeRun: ActiveRun): RunExecutionContext {
	return {
		activeRun,
		start() {
			startActiveRun(activeRun);
		},
		abortAt(unit) {
			abortActiveRun(activeRun, unit);
		},
		markUnitStarted(unit, attempt) {
			return markActiveUnitStarted(activeRun, unit, attempt);
		},
		executeUnit(unit, options) {
			const currentState = readRunStateSnapshot(activeRun.cwd, activeRun.runId);
			if (!currentState) {
				throw new Error(`run state missing while executing: ${activeRun.runId}`);
			}
			return executeUnit(activeRun, unit, currentState, options);
		},
		waitAfterUnit(unit) {
			return waitAfterUnitBoundary(activeRun, unit);
		},
		pause(unit, reason, resultArtifacts) {
			pauseActiveRun(activeRun, unit, reason, resultArtifacts);
		},
		fail(unit, failure, resultArtifacts) {
			failActiveRun(activeRun, unit, failure, resultArtifacts);
		},
		complete() {
			completeActiveRun(activeRun);
		},
		completeUnit(unit, resultArtifacts, additionalPayload = {}, attempt) {
			applyCompletedProgress(activeRun, unit, resultArtifacts, additionalPayload, attempt);
		},
		recordUnitFailureAndContinue(unit, failure, resultArtifacts, attempt) {
			applySkippedFailureProgress(activeRun, unit, failure, resultArtifacts, attempt);
		},
		recordPointAttempt(record) {
			updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
				...current,
				pointAttempts: (current.pointAttempts ?? []).concat({
					...record,
					timestamp: timestamp(),
				}),
				updatedAt: timestamp(),
			}));
		},
	};
}

async function executeManagedRun(activeRun: ActiveRun): Promise<void> {
	const { spec } = activeRun;
	const context = createRunExecutionContext(activeRun);
	context.start();

	if (isParameterSearchRun(spec)) {
		await executeParameterSearchRun(context);
		return;
	}

	if (spec.procedureId !== "raman_grid_mapping") {
		await executeLinearRun(
			context,
			() => spec.procedureId === "raman_single_point_probe" ? singlePointOptions(activeRun) : undefined,
		);
		return;
	}

	await executeMappingRun(context, spec.stoppingRules?.maxConsecutiveFailures ?? DEFAULT_MAPPING_MAX_CONSECUTIVE_FAILURES);
}

function startRun(activeRun: ActiveRun, initialState: RunState): RunState {
	const queuedState = setRunState(activeRun.cwd, initialState);
	activeRun.promise = executeManagedRun(activeRun).catch((error) => {
		updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
			...current,
			status: "failed",
			errorState: {
				errorCode: activeRun.mode === "simulation" ? "simulation_runtime_error" : "live_runtime_error",
				message: error instanceof Error ? error.message : String(error),
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
				scope: "run",
			},
			updatedAt: timestamp(),
			endedAt: timestamp(),
		}));
		activeRuns.delete(activeRun.runId);
		notifyRunTerminal(activeRun.cwd, activeRun.runId);
	});
	activeRuns.set(activeRun.runId, activeRun);
	return queuedState;
}

function startFreshRun(activeRun: ActiveRun): RunState {
	return startRun(activeRun, createBaseRunState(activeRun.runId, activeRun.spec, activeRun.units, activeRun.mode));
}

export function startSimulationRun(
	cwd: string,
	spec: ProcedureSpec,
	controls: SimulationControls = {},
): RunState {
	return startFreshRun({
		runId: `sim-run-${randomUUID().slice(0, 8)}`,
		cwd,
		spec,
		units: limitedUnitsForSpec(spec, compileProcedureSpec(spec)),
		mode: "simulation",
		startIndex: 0,
		controls,
		pauseRequested: false,
		abortRequested: false,
		promise: Promise.resolve(),
	});
}

export function startLiveRamanRun(
	cwd: string,
	spec: ProcedureSpec,
): RunState {
	if (!getRamanLiveRuntime(cwd)) {
		throw new Error(`live Raman runtime not registered for cwd ${cwd}`);
	}

	return startFreshRun({
		runId: `live-run-${randomUUID().slice(0, 8)}`,
		cwd,
		spec,
		units: limitedUnitsForSpec(spec, compileProcedureSpec(spec)),
		mode: "live-supervised",
		startIndex: 0,
		pauseRequested: false,
		abortRequested: false,
		promise: Promise.resolve(),
	});
}

export function pollRun(cwd: string, runId: string): RunState | undefined {
	return readRunStateSnapshot(cwd, runId);
}

export function pauseRun(cwd: string, runId: string): RunState {
	const activeRun = activeRuns.get(runId);
	if (!activeRun) {
		throw new Error(`run not active: ${runId}`);
	}
	activeRun.pauseRequested = true;
	return updateRunState(cwd, runId, (current) => ({
		...current,
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	}));
}

export function abortRun(cwd: string, runId: string): RunState {
	const activeRun = activeRuns.get(runId);
	if (!activeRun) {
		throw new Error(`run not active: ${runId}`);
	}
	activeRun.abortRequested = true;
	return updateRunState(cwd, runId, (current) => ({
		...current,
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	}));
}

export const pollSimulationRun = pollRun;
export const pauseSimulationRun = pauseRun;
export const abortSimulationRun = abortRun;

export class RunResumeError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly stateAfter: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "RunResumeError";
	}
}

export interface RunResumePlan {
	runState: RunState;
	spec: ProcedureSpec;
	units: ExecutionUnit[];
	mode: ExecutionMode;
	startIndex: number;
	unitId: string;
	point?: ExecutionUnit["point"];
}

function resumeExecutionMode(runState: RunState): ExecutionMode {
	// Snapshots written before executionMode was persisted only carry it in the runId prefix.
	return runState.executionMode ?? (runState.runId.startsWith("live-run-") ? "live-supervised" : "simulation");
}

/**
 * Resolve where a paused run would continue, without touching hardware or run state.
 * Resume deliberately reads the frozen spec from disk rather than accepting one from the
 * caller: a resume that could carry a spec would be an approval bypass.
 */
export function planRunResume(cwd: string, runId: string): RunResumePlan {
	const runState = readRunStateSnapshot(cwd, runId);
	if (!runState) {
		throw new RunResumeError(`Run ${runId} was not found.`, "run_not_found");
	}
	if (runState.status !== "paused") {
		throw new RunResumeError(
			`Run ${runId} is not paused; current status is ${runState.status}. Only a paused run can be resumed.`,
			"run_not_paused",
			{ status: runState.status },
		);
	}
	if (activeRuns.has(runId)) {
		throw new RunResumeError(`Run ${runId} is still finishing its pause boundary.`, "run_still_active");
	}
	if (!runState.currentUnit) {
		throw new RunResumeError(
			`Run ${runId} has no recorded current unit, so the resume point is unknown.`,
			"resume_point_unknown",
		);
	}

	const spec = readProcedureSpec(cwd, runState.experimentId, runState.procedureSpecId);
	if (!spec) {
		throw new RunResumeError(
			`Frozen ProcedureSpec ${runState.procedureSpecId} was not found; run ${runId} cannot be resumed.`,
			"frozen_spec_missing",
		);
	}

	const units = limitedUnitsForSpec(spec, compileProcedureSpec(spec));
	const startIndex = runState.currentUnit.index;
	const unit = units[startIndex];
	if (!unit || unit.unitId !== runState.currentUnit.unitId) {
		throw new RunResumeError(
			`Recompiled unit at index ${startIndex} is ${unit?.unitId ?? "missing"}, not the paused unit ${runState.currentUnit.unitId}.`,
			"resume_unit_mismatch",
			{ expectedUnitId: runState.currentUnit.unitId, compiledUnitId: unit?.unitId, totalUnits: units.length },
		);
	}

	return {
		runState,
		spec,
		units,
		mode: resumeExecutionMode(runState),
		startIndex,
		unitId: unit.unitId,
		point: unit.point,
	};
}

export function resumeRun(cwd: string, runId: string): RunState {
	const plan = planRunResume(cwd, runId);
	if (plan.mode === "live-supervised" && !getRamanLiveRuntime(cwd)) {
		throw new RunResumeError(
			`No live Raman runtime is registered for this workspace; run ${runId} cannot be resumed.`,
			"live_runtime_unavailable",
		);
	}

	const resumedState: RunState = {
		...plan.runState,
		status: "running",
		executionMode: plan.mode,
		pauseReason: undefined,
		errorState: undefined,
		endedAt: undefined,
		resumedFromUnitIndexes: (plan.runState.resumedFromUnitIndexes ?? []).concat(plan.startIndex),
		heartbeatAt: timestamp(),
		updatedAt: timestamp(),
	};

	return startRun(
		{
			runId,
			cwd,
			spec: plan.spec,
			units: plan.units,
			mode: plan.mode,
			startIndex: plan.startIndex,
			pauseRequested: false,
			abortRequested: false,
			promise: Promise.resolve(),
		},
		resumedState,
	);
}
