import { randomUUID } from "node:crypto";
import type {
	ExecutionUnit,
	PointAttemptRecord,
	ProcedureSpec,
	RunState,
	RuntimeError,
} from "../schemas/index.ts";
import { appendRunEvent, type RunEvent } from "../store/event-store.ts";
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
import {
	executeLinearRun,
	executeMappingRun,
	executeParameterSearchRun,
	executeTemperatureSeriesRun,
} from "./run-strategies.ts";

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

function createBaseRunState(runId: string, spec: ProcedureSpec, units: ExecutionUnit[]): RunState {
	const now = timestamp();
	return {
		runId,
		experimentId: spec.experimentId,
		procedureSpecId: spec.procedureSpecId,
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
		return runSimulationUnit(activeRun.cwd, activeRun.runId, unit, activeRun.controls ?? {}, currentState);
	}

	const runtime = getRamanLiveRuntime(activeRun.cwd);
	if (!runtime) {
		throw new Error(`live Raman runtime not registered for cwd ${activeRun.cwd}`);
	}

	return runLiveRamanUnit(activeRun.cwd, activeRun.runId, unit, activeRun.spec, runtime, currentState, {
		...options,
		control: {
			shouldPause: () => activeRun.pauseRequested,
			shouldAbort: () => activeRun.abortRequested,
			heartbeat: () => refreshHeartbeat(activeRun),
		},
	});
}

function appendRunStartedEvent(activeRun: ActiveRun): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-started`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "run_started",
		timestamp: timestamp(),
		payload: {
			totalUnits: activeRun.units.length,
			mode: activeRun.mode,
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

	if (spec.procedureId === "raman_temperature_series") {
		await executeTemperatureSeriesRun(context);
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

function startRun(activeRun: ActiveRun): RunState {
	const queuedState = setRunState(activeRun.cwd, createBaseRunState(activeRun.runId, activeRun.spec, activeRun.units));
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
	});
	activeRuns.set(activeRun.runId, activeRun);
	return queuedState;
}

export function startSimulationRun(
	cwd: string,
	spec: ProcedureSpec,
	controls: SimulationControls = {},
): RunState {
	return startRun({
		runId: `sim-run-${randomUUID().slice(0, 8)}`,
		cwd,
		spec,
		units: limitedUnitsForSpec(spec, compileProcedureSpec(spec)),
		mode: "simulation",
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

	return startRun({
		runId: `live-run-${randomUUID().slice(0, 8)}`,
		cwd,
		spec,
		units: limitedUnitsForSpec(spec, compileProcedureSpec(spec)),
		mode: "live-supervised",
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
