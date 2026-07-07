import { randomUUID } from "node:crypto";
import type {
	ExecutionUnit,
	ProcedureSpec,
	RamanAcquisition,
	RamanEvaluationDecision,
	RamanObservationMetrics,
	RunState,
	RuntimeError,
} from "../schemas/index.ts";
import { evaluateRamanGoodEnough, createSearchEnvelopeFromParameterSearch } from "../planner/evaluate-good-enough.ts";
import { appendRunEvent, type RunEvent } from "../store/event-store.ts";
import { readProcedureSpec, saveFrozenProcedureSpec } from "../store/procedure-spec-store.ts";
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
import type { ProcedureProposalRecord } from "../store/proposal-store.ts";
import { hashProcedureSpec } from "../store/proposal-store.ts";
import { compileProcedureSpec } from "./compile-units.ts";

type ExecutionMode = "simulation" | "live-supervised";
type ManagedUnitResult = SimulationUnitResult | LiveRamanUnitResult;

interface ActiveRun {
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

interface ParameterSearchAttemptPlan {
	unit: ExecutionUnit;
	acquisition: RamanAcquisition;
}

const activeRuns = new Map<string, ActiveRun>();

const DEFAULT_MAPPING_MAX_CONSECUTIVE_FAILURES = 3;

function assertApprovedFrozenSpec(cwd: string, spec: ProcedureSpec, approvedProposal: ProcedureProposalRecord): void {
	if (approvedProposal.status !== "approved") {
		throw new Error(`proposal not approved: ${approvedProposal.proposalId}`);
	}

	const requestedHash = hashProcedureSpec(spec);
	if (requestedHash !== approvedProposal.specHash) {
		throw new Error(`approved proposal hash mismatch: ${approvedProposal.proposalId}`);
	}

	const frozenSpec = readProcedureSpec(cwd, spec.experimentId, spec.procedureSpecId);
	if (!frozenSpec) {
		saveFrozenProcedureSpec(cwd, spec);
		return;
	}

	if (hashProcedureSpec(frozenSpec) !== requestedHash) {
		throw new Error(`frozen spec mismatch: ${spec.procedureSpecId}`);
	}
}

function timestamp(): string {
	return new Date().toISOString();
}

function createSimulationRunId(): string {
	return `sim-run-${randomUUID().slice(0, 8)}`;
}

function createLiveRunId(): string {
	return `live-run-${randomUUID().slice(0, 8)}`;
}

function appendEvent(cwd: string, event: RunEvent): void {
	appendRunEvent(cwd, event);
}

function isParameterSearchRun(spec: ProcedureSpec): boolean {
	return spec.procedureId === "raman_parameter_search";
}

function isMappingRun(spec: ProcedureSpec): boolean {
	return spec.procedureId === "raman_grid_mapping";
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

function artifactRefsForResult(result: ManagedUnitResult): RunState["artifactRefs"] {
	return result.artifactRefs;
}

function errorForResult(result: Extract<ManagedUnitResult, { status: "failed" }>): RuntimeError {
	return result.error;
}

function runErrorCodeForMode(mode: ExecutionMode): string {
	return mode === "simulation" ? "simulation_runtime_error" : "live_runtime_error";
}

function getObservationMetrics(result: ManagedUnitResult): RamanObservationMetrics | undefined {
	if (result.status !== "completed") {
		return undefined;
	}
	return result.observationMetrics;
}

function getCompletedDecision(result: ManagedUnitResult): RamanEvaluationDecision | undefined {
	if (result.status !== "completed" || !("evaluationDecision" in result)) {
		return undefined;
	}
	return result.evaluationDecision;
}

function interpolateNumber(minimum: number, maximum: number, index: number, total: number): number {
	if (total <= 1 || minimum === maximum) {
		return minimum;
	}
	return minimum + (maximum - minimum) * (index / (total - 1));
}

function interpolateInteger(minimum: number, maximum: number, index: number, total: number): number {
	return Math.round(interpolateNumber(minimum, maximum, index, total));
}

function deriveParameterSearchAcquisition(
	spec: ProcedureSpec,
	attemptIndex: number,
	attemptCount: number,
): RamanAcquisition {
	const envelope = spec.domain.raman.parameterSearch;
	const base = spec.domain.raman.acquisition;
	if (!envelope) {
		return base;
	}

	const acquisition: RamanAcquisition = {
		...base,
		laserPowerPercent:
			envelope.laserPowerPercentValues === undefined
				? base.laserPowerPercent
				: envelope.laserPowerPercentValues[Math.min(attemptIndex, envelope.laserPowerPercentValues.length - 1)],
		integrationTimeMs:
			envelope.integrationTimeMs === undefined
				? base.integrationTimeMs
				: interpolateInteger(
						envelope.integrationTimeMs.min,
						envelope.integrationTimeMs.max,
						attemptIndex,
						attemptCount,
					),
		accumulations:
			envelope.accumulations === undefined
				? base.accumulations
				: envelope.accumulations[Math.min(attemptIndex, envelope.accumulations.length - 1)],
	};

	if (envelope.laserPowerPercentValues && !envelope.laserPowerPercentValues.includes(acquisition.laserPowerPercent)) {
		throw new Error(`parameter search attempted laserPowerPercent outside approved values at attempt ${attemptIndex + 1}`);
	}
	if (
		envelope.integrationTimeMs &&
		(acquisition.integrationTimeMs < envelope.integrationTimeMs.min ||
			acquisition.integrationTimeMs > envelope.integrationTimeMs.max)
	) {
		throw new Error(
			`parameter search attempted integrationTimeMs outside approved envelope at attempt ${attemptIndex + 1}`,
		);
	}
	if (envelope.accumulations && !envelope.accumulations.includes(acquisition.accumulations)) {
		throw new Error(`parameter search attempted accumulations outside approved envelope at attempt ${attemptIndex + 1}`);
	}

	return acquisition;
}

function buildParameterSearchPlans(spec: ProcedureSpec, units: ExecutionUnit[]): ParameterSearchAttemptPlan[] {
	const envelope = spec.domain.raman.parameterSearch;
	if (!envelope) {
		throw new Error(`raman_parameter_search requires domain.raman.parameterSearch: ${spec.procedureSpecId}`);
	}

	return units.map((unit, index) => ({
		unit,
		acquisition: deriveParameterSearchAcquisition(spec, index, units.length),
	}));
}

function createDecisionPauseReason(attemptIndex: number, decision: RamanEvaluationDecision): string {
	return `Parameter search attempt ${attemptIndex + 1} completed and explicit evaluation returned ${decision.decision}.`;
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

	return runLiveRamanUnit(activeRun.cwd, activeRun.runId, unit, activeRun.spec, runtime, currentState, options);
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

function appendUnitStartedEvent(activeRun: ActiveRun, unit: ExecutionUnit): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-unit-start-${unit.index}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "unit_started",
		timestamp: timestamp(),
		payload: { unitId: unit.unitId, index: unit.index },
	});
}

function appendUnitCompletedEvent(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	artifacts: RunState["artifactRefs"],
	additionalPayload: Record<string, unknown> = {},
): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-unit-complete-${unit.index}`,
		runId: activeRun.runId,
		experimentId: activeRun.spec.experimentId,
		eventType: "unit_completed",
		timestamp: timestamp(),
		payload: {
			unitId: unit.unitId,
			index: unit.index,
			artifacts: artifacts.map((artifact) => artifact.artifactId),
			...additionalPayload,
		},
	});
}

function appendUnitFailedEvent(activeRun: ActiveRun, unit: ExecutionUnit, failure: RuntimeError, artifacts: RunState["artifactRefs"]): void {
	appendEvent(activeRun.cwd, {
		eventId: `${activeRun.runId}-failed-${unit.index}`,
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
	appendUnitCompletedEvent(activeRun, unit, resultArtifacts, additionalPayload);
}

function applySkippedFailureProgress(
	activeRun: ActiveRun,
	unit: ExecutionUnit,
	failure: RuntimeError,
	resultArtifacts: RunState["artifactRefs"],
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
	appendUnitFailedEvent(activeRun, unit, failure, resultArtifacts);
}

function evaluateParameterSearchResult(
	activeRun: ActiveRun,
	result: ManagedUnitResult,
	attemptIndex: number,
	recentObservations: RamanObservationMetrics[],
): RamanEvaluationDecision {
	if (!isParameterSearchRun(activeRun.spec)) {
		throw new Error(`parameter search evaluation requested for non-parameter-search run: ${activeRun.spec.procedureId}`);
	}

	const envelope = createSearchEnvelopeFromParameterSearch(activeRun.spec.domain.raman.parameterSearch!);
	if (activeRun.mode === "live-supervised") {
		const decision = getCompletedDecision(result);
		if (!decision) {
			throw new Error(`live parameter search attempt ${attemptIndex + 1} did not return an evaluation decision`);
		}
		return decision;
	}

	const currentMetrics = getObservationMetrics(result);
	if (!currentMetrics) {
		throw new Error(`simulation parameter search attempt ${attemptIndex + 1} is missing observation metrics`);
	}

	return evaluateRamanGoodEnough(
		{
			attemptIndex,
			current: currentMetrics,
			recentObservations,
		},
		envelope,
	);
}

function parameterSearchOptions(
	activeRun: ActiveRun,
	attemptIndex: number,
	acquisition: RamanAcquisition,
	recentObservations: RamanObservationMetrics[],
): LiveRamanUnitOptions | undefined {
	if (activeRun.mode !== "live-supervised") {
		return undefined;
	}

	return {
		acquisitionOverride: acquisition,
		evaluation: {
			attemptIndex,
			recentObservations,
			envelope: createSearchEnvelopeFromParameterSearch(activeRun.spec.domain.raman.parameterSearch!),
		},
	};
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

async function executeManagedRun(activeRun: ActiveRun): Promise<void> {
	const { cwd, runId, spec, units } = activeRun;
	updateRunState(cwd, runId, (current) => ({
		...current,
		status: "running",
		updatedAt: timestamp(),
		heartbeatAt: timestamp(),
	}));
	appendRunStartedEvent(activeRun);

	const mappingFailureLimit = spec.stoppingRules?.maxConsecutiveFailures ?? DEFAULT_MAPPING_MAX_CONSECUTIVE_FAILURES;
	let consecutiveMappingFailures = 0;
	const searchObservations: RamanObservationMetrics[] = [];

	if (isParameterSearchRun(spec)) {
		const attempts = buildParameterSearchPlans(spec, units);
		for (const [attemptIndex, attempt] of attempts.entries()) {
			const unit = attempt.unit;
			if (activeRun.abortRequested) {
				updateRunState(cwd, runId, (current) => ({
					...current,
					status: "aborted",
					abortReason: "operator_requested",
					updatedAt: timestamp(),
					endedAt: timestamp(),
				}));
				appendEvent(cwd, {
					eventId: `${runId}-aborted-${unit.index}`,
					runId,
					experimentId: spec.experimentId,
					eventType: "run_aborted",
					timestamp: timestamp(),
					payload: { unitId: unit.unitId, index: unit.index },
				});
				activeRuns.delete(runId);
				return;
			}

			appendUnitStartedEvent(activeRun, unit);
			updateRunState(cwd, runId, (current) => ({
				...current,
				status: "running",
				currentUnit: { unitId: unit.unitId, index: unit.index },
				heartbeatAt: timestamp(),
				updatedAt: timestamp(),
			}));

			const currentState = readRunStateSnapshot(cwd, runId);
			if (!currentState) {
				throw new Error(`run state missing while executing: ${runId}`);
			}

			const result = await executeUnit(
				activeRun,
				unit,
				currentState,
				parameterSearchOptions(activeRun, attemptIndex, attempt.acquisition, searchObservations),
			);
			const resultArtifacts = artifactRefsForResult(result);

			if (activeRun.pauseRequested || result.status === "paused") {
				pauseActiveRun(activeRun, unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
				return;
			}

			if (result.status === "failed") {
				failActiveRun(activeRun, unit, errorForResult(result), resultArtifacts);
				return;
			}

			const metrics = getObservationMetrics(result);
			if (!metrics) {
				failActiveRun(activeRun, unit, {
					errorCode: "missing_evaluation_metrics",
					message: "Parameter search attempts require explicit observation metrics for rule-based evaluation.",
					retrySafe: false,
					needsOperator: true,
					safeToResume: false,
					scope: "unit",
				}, resultArtifacts);
				return;
			}

			const decision = evaluateParameterSearchResult(activeRun, result, attemptIndex, searchObservations);
			applyCompletedProgress(activeRun, unit, resultArtifacts, {
				decision: decision.decision,
				attemptIndex,
				acquisition: attempt.acquisition,
			});
			searchObservations.unshift(metrics);

			if (decision.decision === "acceptable") {
				completeActiveRun(activeRun);
				return;
			}

			if (decision.decision === "stop_and_request_user_decision") {
				pauseActiveRun(activeRun, unit, createDecisionPauseReason(attemptIndex, decision), []);
				return;
			}
		}

		completeActiveRun(activeRun);
		return;
	}

	for (const unit of units) {
		if (activeRun.abortRequested) {
			updateRunState(cwd, runId, (current) => ({
				...current,
				status: "aborted",
				abortReason: "operator_requested",
				updatedAt: timestamp(),
				endedAt: timestamp(),
			}));
			appendEvent(cwd, {
				eventId: `${runId}-aborted-${unit.index}`,
				runId,
				experimentId: spec.experimentId,
				eventType: "run_aborted",
				timestamp: timestamp(),
				payload: { unitId: unit.unitId, index: unit.index },
			});
			activeRuns.delete(runId);
			return;
		}

		appendUnitStartedEvent(activeRun, unit);
		updateRunState(cwd, runId, (current) => ({
			...current,
			status: "running",
			currentUnit: { unitId: unit.unitId, index: unit.index },
			heartbeatAt: timestamp(),
			updatedAt: timestamp(),
		}));

		const currentState = readRunStateSnapshot(cwd, runId);
		if (!currentState) {
			throw new Error(`run state missing while executing: ${runId}`);
		}

		const result = await executeUnit(
			activeRun,
			unit,
			currentState,
			spec.procedureId === "raman_single_point_probe" ? singlePointOptions(activeRun) : undefined,
		);
		const resultArtifacts = artifactRefsForResult(result);

		if (activeRun.pauseRequested || result.status === "paused") {
			pauseActiveRun(activeRun, unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
			return;
		}

		if (result.status === "failed") {
			const failure = errorForResult(result);
			if (isMappingRun(spec) && spec.stoppingRules?.stopOnError === false) {
				applySkippedFailureProgress(activeRun, unit, failure, resultArtifacts);
				consecutiveMappingFailures += 1;
				if (consecutiveMappingFailures >= mappingFailureLimit) {
					failActiveRun(activeRun, unit, {
						errorCode: "mapping_consecutive_failures_limit_reached",
						message: `Mapping stopped after ${consecutiveMappingFailures} consecutive point failures.`,
						retrySafe: false,
						needsOperator: true,
						safeToResume: false,
						scope: "run",
					}, []);
					return;
				}
				continue;
			}

			failActiveRun(activeRun, unit, failure, resultArtifacts);
			return;
		}

		consecutiveMappingFailures = 0;
		applyCompletedProgress(activeRun, unit, resultArtifacts);
	}

	completeActiveRun(activeRun);
}

function startRun(activeRun: ActiveRun): RunState {
	const queuedState = setRunState(activeRun.cwd, createBaseRunState(activeRun.runId, activeRun.spec, activeRun.units));
	activeRun.promise = executeManagedRun(activeRun).catch((error) => {
		updateRunState(activeRun.cwd, activeRun.runId, (current) => ({
			...current,
			status: "failed",
			errorState: {
				errorCode: runErrorCodeForMode(activeRun.mode),
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
	approvedProposal: ProcedureProposalRecord,
): RunState {
	assertApprovedFrozenSpec(cwd, spec, approvedProposal);
	return startRun({
		runId: createSimulationRunId(),
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
	approvedProposal: ProcedureProposalRecord,
): RunState {
	assertApprovedFrozenSpec(cwd, spec, approvedProposal);

	if (!getRamanLiveRuntime(cwd)) {
		throw new Error(`live Raman runtime not registered for cwd ${cwd}`);
	}

	return startRun({
		runId: createLiveRunId(),
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
