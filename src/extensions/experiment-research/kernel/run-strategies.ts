import type {
	ExecutionUnit,
	RamanAcquisition,
	RamanEvaluationDecision,
	RamanObservationMetrics,
	RetryFailureReason,
	RetryFailureType,
	RunState,
	RuntimeError,
} from "../schemas/index.ts";
import {
	DEFAULT_RAMAN_EVALUATION_CONFIG,
	createSearchEnvelopeFromParameterSearch,
	evaluateRamanGoodEnough,
} from "../planner/evaluate-good-enough.ts";
import type { LiveRamanUnitOptions } from "../runtime/raman/index.ts";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../schemas/index.ts";
import type { ManagedUnitResult, RunExecutionContext, UnitAttemptContext } from "./run-controller.ts";

type UnitOptionsProvider = (unit: ExecutionUnit) => LiveRamanUnitOptions | undefined;

interface AttemptExecution {
	result: ManagedUnitResult;
	artifacts: RunState["artifactRefs"];
	attempt: UnitAttemptContext;
}

function initialAttemptForUnit(context: RunExecutionContext, unit: ExecutionUnit): UnitAttemptContext {
	return {
		phase: "initial",
		attemptIndex: context.activeRun.resumeAttemptIndexByUnit?.[unit.unitId] ?? 0,
	};
}

interface ParameterSearchAttemptPlan {
	unit: ExecutionUnit;
	acquisition: RamanAcquisition;
}

interface ClassifiedFailure {
	failure: RuntimeError;
	failureType: RetryFailureType;
	failureReason: RetryFailureReason;
	artifacts: RunState["artifactRefs"];
}

interface FinalRetryQueueItem {
	unit: ExecutionUnit;
	nextAttemptIndex: number;
}

const SYSTEMIC_RUNTIME_ERROR_CODES = new Set([
	"unknown_python_action",
	"python_runtime_protocol_mismatch",
	"python_runtime_spawn_failed",
	"python_runtime_exit_failed",
	"python_runtime_parse_failed",
	"python_runtime_bad_request",
	"python_runtime_closed",
	"python_runtime_error",
	"invalid_runtime_contract",
	"resource_unavailable",
	"driver_not_loaded",
	"driver_unavailable",
	"bridge_unavailable",
]);

function isSystemicRuntimeFailure(failure: RuntimeError): boolean {
	return failure.scope === "run" || SYSTEMIC_RUNTIME_ERROR_CODES.has(failure.errorCode);
}

function stopBeforeUnit(context: RunExecutionContext, unit: ExecutionUnit): boolean {
	if (context.activeRun.abortRequested) {
		context.abortAt(unit);
		return true;
	}
	if (context.deadlineExceeded()) {
		context.failDeadline(unit);
		return true;
	}
	return false;
}

function artifactRefsForResult(result: ManagedUnitResult): RunState["artifactRefs"] {
	return result.artifactRefs;
}

function errorForResult(result: Extract<ManagedUnitResult, { status: "failed" }>): RuntimeError {
	return result.error;
}

function isDataAvailabilityFailure(failure: RuntimeError): boolean {
	return failure.errorCode === "source_artifact_unavailable";
}

function classifyRuntimeFailure(failure: RuntimeError, artifacts: RunState["artifactRefs"]): ClassifiedFailure | undefined {
	if (failure.errorCode === "source_artifact_unavailable") {
		return {
			failure,
			failureType: "data",
			failureReason: "source_artifact_unavailable",
			artifacts,
		};
	}
	if (failure.errorCode.includes("timeout")) {
		return {
			failure,
			failureType: "execution",
			failureReason: "timeout",
			artifacts,
		};
	}
	if (failure.retrySafe && (failure.errorCode === "autofocus_low_confidence" || failure.errorCode === "low_focus_confidence")) {
		return {
			failure,
			failureType: "quality",
			failureReason: "low_focus_confidence",
			artifacts,
		};
	}
	return undefined;
}

function classifyQualityFailure(result: ManagedUnitResult, artifacts: RunState["artifactRefs"]): ClassifiedFailure | undefined {
	const metrics = getObservationMetrics(result);
	if (!metrics || metrics.autofocusConfidence >= DEFAULT_RAMAN_EVALUATION_CONFIG.autofocusConfidenceMin) {
		return undefined;
	}
	return {
		failure: {
			errorCode: "autofocus_low_confidence",
			message: `Autofocus confidence ${metrics.autofocusConfidence} is below threshold ${DEFAULT_RAMAN_EVALUATION_CONFIG.autofocusConfidenceMin}.`,
			retrySafe: true,
			needsOperator: false,
			safeToResume: true,
			scope: "unit",
			payload: {
				confidence: metrics.autofocusConfidence,
				threshold: DEFAULT_RAMAN_EVALUATION_CONFIG.autofocusConfidenceMin,
			},
		},
		failureType: "quality",
		failureReason: "low_focus_confidence",
		artifacts,
	};
}

function classifyMappingFailure(result: ManagedUnitResult, artifacts: RunState["artifactRefs"]): ClassifiedFailure | undefined {
	if (result.status === "failed") {
		return classifyRuntimeFailure(errorForResult(result), artifacts);
	}
	return classifyQualityFailure(result, artifacts);
}

function retryPolicyAllows(policy: RetryPolicy, failure: ClassifiedFailure): boolean {
	if (failure.failureType === "execution") {
		return failure.failureReason === "timeout" && policy.retryableFailureReasons.execution.includes(failure.failureReason);
	}
	if (failure.failureType === "quality") {
		return failure.failureReason === "low_focus_confidence" && policy.retryableFailureReasons.quality.includes(failure.failureReason);
	}
	return failure.failureReason === "source_artifact_unavailable" &&
		(policy.retryableFailureReasons.data ?? []).includes(failure.failureReason);
}

function artifactIds(artifacts: RunState["artifactRefs"]): string[] {
	return artifacts.map((artifact) => artifact.artifactId);
}

function recordAttempt(
	context: RunExecutionContext,
	unit: ExecutionUnit,
	attempt: UnitAttemptContext,
	status: "succeeded" | "failed",
	artifacts: RunState["artifactRefs"],
	failure?: ClassifiedFailure | RuntimeError,
	finalForPoint?: boolean,
): void {
	const runtimeFailure = failure && "failure" in failure ? failure.failure : failure;
	const classifiedFailure = failure && "failure" in failure ? failure : undefined;
	context.recordPointAttempt({
		pointUnitId: unit.unitId,
		attemptId: `${unit.unitId}:${attempt.phase}:${attempt.attemptIndex}`,
		attemptIndex: attempt.attemptIndex,
		phase: attempt.phase,
		status,
		failureType: classifiedFailure?.failureType,
		failureReason: classifiedFailure?.failureReason,
		errorCode: runtimeFailure?.errorCode,
		errorMessage: runtimeFailure?.message,
		finalForPoint,
		artifactIds: artifactIds(artifacts),
	}, status === "failed" && finalForPoint === false ? artifacts : []);
}

async function executeWithImmediateDataRetry(
	context: RunExecutionContext,
	unit: ExecutionUnit,
	optionsForAttempt: (attempt: UnitAttemptContext) => LiveRamanUnitOptions | undefined,
): Promise<AttemptExecution | undefined> {
	const retryPolicy = context.activeRun.spec.retryPolicy ?? DEFAULT_RETRY_POLICY;
	let attempt = initialAttemptForUnit(context, unit);
	let retriesUsed = 0;

	while (true) {
		context.markUnitStarted(unit, attempt);
		const result = await context.executeUnit(unit, {
			...optionsForAttempt(attempt),
			attempt,
		});
		const artifacts = artifactRefsForResult(result);

		if (context.activeRun.abortRequested || result.status === "aborted") {
			context.abortAt(unit, artifacts);
			return undefined;
		}
		if (context.activeRun.pauseRequested || result.status === "paused") {
			context.pause(unit, result.status === "paused" ? result.reason : "operator_requested", artifacts);
			return undefined;
		}
		if (context.deadlineExceeded()) {
			context.failDeadline(unit, artifacts);
			return undefined;
		}

		if (result.status !== "failed") {
			return { result, artifacts, attempt };
		}
		const classifiedFailure = classifyRuntimeFailure(result.error, artifacts);
		if (
			classifiedFailure?.failureType !== "data" ||
			!retryPolicyAllows(retryPolicy, classifiedFailure) ||
			retriesUsed >= Math.min(retryPolicy.maxImmediateRetriesPerPoint, 1)
		) {
			return { result, artifacts, attempt };
		}

		recordAttempt(context, unit, attempt, "failed", artifacts, classifiedFailure, false);
		retriesUsed += 1;
		attempt = { phase: "immediate_retry", attemptIndex: attempt.attemptIndex + 1 };
	}
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

function deriveParameterSearchAcquisition(
	context: RunExecutionContext,
	attemptIndex: number,
	attemptCount: number,
): RamanAcquisition {
	const envelope = context.activeRun.spec.domain.raman.parameterSearch;
	const base = context.activeRun.spec.domain.raman.acquisition;
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
				: Math.round(interpolateNumber(
						envelope.integrationTimeMs.min,
						envelope.integrationTimeMs.max,
						attemptIndex,
						attemptCount,
					)),
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

function buildParameterSearchPlans(context: RunExecutionContext): ParameterSearchAttemptPlan[] {
	const { spec, units } = context.activeRun;
	const envelope = spec.domain.raman.parameterSearch;
	if (!envelope) {
		throw new Error(`raman_parameter_search requires domain.raman.parameterSearch: ${spec.procedureSpecId}`);
	}

	return units.map((unit, index) => ({
		unit,
		acquisition: deriveParameterSearchAcquisition(context, index, units.length),
	}));
}

function evaluateParameterSearchResult(
	context: RunExecutionContext,
	result: ManagedUnitResult,
	attemptIndex: number,
	recentObservations: RamanObservationMetrics[],
): RamanEvaluationDecision {
	const { activeRun } = context;
	if (activeRun.spec.procedureId !== "raman_parameter_search") {
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
	context: RunExecutionContext,
	attemptIndex: number,
	acquisition: RamanAcquisition,
	recentObservations: RamanObservationMetrics[],
): LiveRamanUnitOptions | undefined {
	const { activeRun } = context;
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

export async function executeLinearRun(
	context: RunExecutionContext,
	unitOptions: UnitOptionsProvider = () => undefined,
): Promise<void> {
	const { activeRun } = context;

	for (const unit of activeRun.units) {
		if (stopBeforeUnit(context, unit)) {
			return;
		}

		const options = unitOptions(unit);
		const execution = await executeWithImmediateDataRetry(context, unit, (attempt) => ({
			...options,
			evaluation: options?.evaluation ? { ...options.evaluation, attemptIndex: attempt.attemptIndex } : undefined,
		}));
		if (!execution) {
			return;
		}
		const { result, artifacts: resultArtifacts, attempt } = execution;

		if (result.status === "failed") {
			const failure = errorForResult(result);
			if (
				isDataAvailabilityFailure(failure) ||
				(activeRun.spec.stoppingRules?.stopOnError === false && !isSystemicRuntimeFailure(failure))
			) {
				recordAttempt(context, unit, attempt, "failed", resultArtifacts, failure, true);
				context.recordUnitFailureAndContinue(unit, failure, resultArtifacts, attempt);
				continue;
			}
			context.fail(unit, failure, resultArtifacts);
			return;
		}

		context.completeUnit(unit, resultArtifacts, {}, attempt);
	}

	context.complete();
}

export async function executeParameterSearchRun(context: RunExecutionContext): Promise<void> {
	const attempts = buildParameterSearchPlans(context);
	const searchObservations: RamanObservationMetrics[] = [];

	for (const [attemptIndex, attempt] of attempts.entries()) {
		const unit = attempt.unit;
		if (stopBeforeUnit(context, unit)) {
			return;
		}

		const execution = await executeWithImmediateDataRetry(context, unit, () => ({
			...parameterSearchOptions(context, attemptIndex, attempt.acquisition, searchObservations),
		}));
		if (!execution) {
			return;
		}
		const { result, artifacts: resultArtifacts, attempt: runtimeAttempt } = execution;

		if (result.status === "failed") {
			const failure = errorForResult(result);
			if (isDataAvailabilityFailure(failure)) {
				recordAttempt(context, unit, runtimeAttempt, "failed", resultArtifacts, failure, true);
				context.recordUnitFailureAndContinue(unit, failure, resultArtifacts, runtimeAttempt);
				continue;
			}
			context.fail(unit, failure, resultArtifacts);
			return;
		}

		const metrics = getObservationMetrics(result);
		if (!metrics) {
			context.completeUnit(unit, resultArtifacts, {
				analysisAvailable: false,
				attemptIndex,
				acquisition: attempt.acquisition,
			}, runtimeAttempt);
			continue;
		}

		const decision = evaluateParameterSearchResult(context, result, attemptIndex, searchObservations);
		context.completeUnit(unit, resultArtifacts, {
			decision: decision.decision,
			attemptIndex,
			acquisition: attempt.acquisition,
		}, runtimeAttempt);
		searchObservations.unshift(metrics);

		if (decision.decision === "acceptable") {
			context.complete();
			return;
		}

		if (decision.decision === "stop_and_request_user_decision") {
			context.pause(
				unit,
				`Parameter search attempt ${attemptIndex + 1} completed and explicit evaluation returned ${decision.decision}.`,
				[],
			);
			return;
		}
	}

	context.complete();
}

export async function executeMappingRun(context: RunExecutionContext, failureLimit: number): Promise<void> {
	const { activeRun } = context;
	const retryPolicy = context.activeRun.spec.retryPolicy ?? DEFAULT_RETRY_POLICY;
	const finalRetryQueue: FinalRetryQueueItem[] = [];
	let consecutiveMappingFailures = 0;

	async function runMappingAttempt(
		unit: ExecutionUnit,
		attempt: UnitAttemptContext,
		finalAttemptExhausted = true,
	): Promise<"succeeded" | "queued_final_retry" | "continued_data_failure" | "failed" | "run_failed" | "paused" | "aborted"> {
		if (stopBeforeUnit(context, unit)) {
			return "run_failed";
		}

		context.markUnitStarted(unit, attempt);
		const result = await context.executeUnit(unit, {
			attempt: { attemptIndex: attempt.attemptIndex, phase: attempt.phase },
		});
		const resultArtifacts = artifactRefsForResult(result);

		if (activeRun.abortRequested || result.status === "aborted") {
			context.abortAt(unit, resultArtifacts);
			return "aborted";
		}
		if (activeRun.pauseRequested || result.status === "paused") {
			context.pause(unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
			return "paused";
		}
		if (context.deadlineExceeded()) {
			context.failDeadline(unit, resultArtifacts);
			return "run_failed";
		}
		if (
			result.status === "failed" &&
			isSystemicRuntimeFailure(result.error)
		) {
			recordAttempt(context, unit, attempt, "failed", resultArtifacts, result.error, true);
			context.fail(unit, result.error, resultArtifacts);
			return "run_failed";
		}

		const classifiedFailure = classifyMappingFailure(result, resultArtifacts);
		if (!classifiedFailure) {
			if (result.status === "failed") {
				const failure = errorForResult(result);
				recordAttempt(context, unit, attempt, "failed", resultArtifacts, failure, true);
				if (activeRun.spec.stoppingRules?.stopOnError === false) {
					context.recordUnitFailureAndContinue(unit, failure, resultArtifacts, attempt);
					consecutiveMappingFailures += 1;
					if (consecutiveMappingFailures >= failureLimit) {
						context.fail(unit, {
							errorCode: "mapping_consecutive_failures_limit_reached",
							message: `Mapping stopped after ${consecutiveMappingFailures} consecutive point failures.`,
							retrySafe: false,
							needsOperator: true,
							safeToResume: false,
							scope: "run",
							payload: { triggeringError: failure },
						}, []);
						return "run_failed";
					}
					return "failed";
				}

				context.fail(unit, failure, resultArtifacts);
				return "run_failed";
			}
			consecutiveMappingFailures = 0;
			recordAttempt(context, unit, attempt, "succeeded", resultArtifacts, undefined, true);
			context.completeUnit(unit, resultArtifacts, {}, attempt);
			return "succeeded";
		}

		const retryableByPolicy = retryPolicyAllows(retryPolicy, classifiedFailure);
		const immediateRetriesAvailable =
			attempt.phase !== "final_retry" &&
			retryPolicy.maxImmediateRetriesPerPoint > 0 &&
			(classifiedFailure.failureType === "data"
				? attempt.phase === "initial"
				: attempt.attemptIndex < retryPolicy.maxImmediateRetriesPerPoint);
		if (retryableByPolicy && immediateRetriesAvailable) {
			recordAttempt(context, unit, attempt, "failed", resultArtifacts, classifiedFailure, false);
			return runMappingAttempt(unit, {
				phase: "immediate_retry",
				attemptIndex: attempt.attemptIndex + 1,
			});
		}

		if (attempt.phase === "final_retry" && retryableByPolicy && !finalAttemptExhausted) {
			recordAttempt(context, unit, attempt, "failed", resultArtifacts, classifiedFailure, false);
			return "failed";
		}

		const finalRetriesAvailable =
			attempt.phase !== "final_retry" &&
			retryableByPolicy &&
			classifiedFailure.failureType !== "data" &&
			retryPolicy.maxFinalRetriesPerPoint > 0;
		if (finalRetriesAvailable) {
			recordAttempt(context, unit, attempt, "failed", resultArtifacts, classifiedFailure, false);
			finalRetryQueue.push({
				unit,
				nextAttemptIndex: attempt.attemptIndex + 1,
			});
			return "queued_final_retry";
		}

		recordAttempt(context, unit, attempt, "failed", resultArtifacts, classifiedFailure, true);
		if (classifiedFailure.failureType === "data") {
			context.recordUnitFailureAndContinue(unit, classifiedFailure.failure, resultArtifacts, attempt);
			consecutiveMappingFailures = 0;
			return "continued_data_failure";
		}
		if (activeRun.spec.stoppingRules?.stopOnError === false) {
			context.recordUnitFailureAndContinue(unit, classifiedFailure.failure, resultArtifacts, attempt);
			consecutiveMappingFailures += 1;
			if (consecutiveMappingFailures >= failureLimit) {
				context.fail(unit, {
					errorCode: "mapping_consecutive_failures_limit_reached",
					message: `Mapping stopped after ${consecutiveMappingFailures} consecutive point failures.`,
					retrySafe: false,
					needsOperator: true,
					safeToResume: false,
					scope: "run",
					payload: { triggeringError: classifiedFailure.failure },
				}, []);
				return "run_failed";
			}
			return "failed";
		}

		context.fail(unit, classifiedFailure.failure, resultArtifacts);
		return "run_failed";
	}

	for (const unit of activeRun.units) {
		const outcome = await runMappingAttempt(unit, initialAttemptForUnit(context, unit));
		if (outcome === "paused" || outcome === "aborted" || outcome === "run_failed") {
			return;
		}
	}

	for (const item of finalRetryQueue) {
		for (let offset = 0; offset < retryPolicy.maxFinalRetriesPerPoint; offset++) {
			const finalAttemptExhausted = offset + 1 >= retryPolicy.maxFinalRetriesPerPoint;
			const outcome = await runMappingAttempt(item.unit, {
				phase: "final_retry",
				attemptIndex: item.nextAttemptIndex + offset,
			}, finalAttemptExhausted);
			if (
				outcome === "succeeded" ||
				outcome === "continued_data_failure" ||
				outcome === "paused" ||
				outcome === "aborted" ||
				outcome === "run_failed"
			) {
				if (outcome === "paused" || outcome === "aborted" || outcome === "run_failed") {
					return;
				}
				break;
			}
			if (outcome === "failed" && !finalAttemptExhausted) {
				continue;
			}
			if (outcome === "failed") {
				if (activeRun.spec.stoppingRules?.stopOnError !== false) {
					return;
				}
				break;
			}
		}
	}

	context.complete();
}
