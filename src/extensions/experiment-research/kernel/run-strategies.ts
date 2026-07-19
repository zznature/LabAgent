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

function artifactRefsForResult(result: ManagedUnitResult): RunState["artifactRefs"] {
	return result.artifactRefs;
}

function errorForResult(result: Extract<ManagedUnitResult, { status: "failed" }>): RuntimeError {
	return result.error;
}

function classifyRuntimeFailure(failure: RuntimeError, artifacts: RunState["artifactRefs"]): ClassifiedFailure | undefined {
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
	return failure.failureReason === "low_focus_confidence" && policy.retryableFailureReasons.quality.includes(failure.failureReason);
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
	failure?: ClassifiedFailure,
	finalForPoint?: boolean,
): void {
	context.recordPointAttempt({
		pointUnitId: unit.unitId,
		attemptId: `${unit.unitId}:${attempt.phase}:${attempt.attemptIndex}`,
		attemptIndex: attempt.attemptIndex,
		phase: attempt.phase,
		status,
		failureType: failure?.failureType,
		failureReason: failure?.failureReason,
		errorCode: failure?.failure.errorCode,
		finalForPoint,
		artifactIds: artifactIds(artifacts),
	});
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
		if (activeRun.abortRequested) {
			context.abortAt(unit);
			return;
		}

		context.markUnitStarted(unit);
		const result = await context.executeUnit(unit, unitOptions(unit));
		const resultArtifacts = artifactRefsForResult(result);

		if (activeRun.pauseRequested || result.status === "paused") {
			context.pause(unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
			return;
		}

		if (result.status === "failed") {
			context.fail(unit, errorForResult(result), resultArtifacts);
			return;
		}

		context.completeUnit(unit, resultArtifacts);
		const waitResult = await context.waitAfterUnit(unit);
		if (waitResult !== "continue") {
			return;
		}
	}

	context.complete();
}

export async function executeParameterSearchRun(context: RunExecutionContext): Promise<void> {
	const { activeRun } = context;
	const attempts = buildParameterSearchPlans(context);
	const searchObservations: RamanObservationMetrics[] = [];

	for (const [attemptIndex, attempt] of attempts.entries()) {
		const unit = attempt.unit;
		if (activeRun.abortRequested) {
			context.abortAt(unit);
			return;
		}

		context.markUnitStarted(unit);

		const result = await context.executeUnit(
			unit,
			parameterSearchOptions(context, attemptIndex, attempt.acquisition, searchObservations),
		);
		const resultArtifacts = artifactRefsForResult(result);

		if (activeRun.pauseRequested || result.status === "paused") {
			context.pause(unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
			return;
		}

		if (result.status === "failed") {
			context.fail(unit, errorForResult(result), resultArtifacts);
			return;
		}

		const metrics = getObservationMetrics(result);
		if (!metrics) {
			context.fail(unit, {
				errorCode: "missing_evaluation_metrics",
				message: "Parameter search attempts require explicit observation metrics for rule-based evaluation.",
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
				scope: "unit",
			}, resultArtifacts);
			return;
		}

		const decision = evaluateParameterSearchResult(context, result, attemptIndex, searchObservations);
		context.completeUnit(unit, resultArtifacts, {
			decision: decision.decision,
			attemptIndex,
			acquisition: attempt.acquisition,
		});
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

		const waitResult = await context.waitAfterUnit(unit);
		if (waitResult !== "continue") {
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
	): Promise<"succeeded" | "queued_final_retry" | "failed" | "run_failed" | "paused" | "aborted"> {
		if (activeRun.abortRequested) {
			context.abortAt(unit);
			return "aborted";
		}

		context.markUnitStarted(unit, attempt);
		const result = await context.executeUnit(unit);
		const resultArtifacts = artifactRefsForResult(result);

		if (activeRun.pauseRequested || result.status === "paused") {
			context.pause(unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
			return "paused";
		}

		const classifiedFailure = classifyMappingFailure(result, resultArtifacts);
		if (!classifiedFailure) {
			if (result.status === "failed") {
				const failure = errorForResult(result);
				recordAttempt(context, unit, attempt, "failed", resultArtifacts, undefined, true);
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
					}, []);
					return "run_failed";
				}
				const waitResult = await context.waitAfterUnit(unit);
				if (waitResult !== "continue") {
					return waitResult;
				}
				return "failed";
			}

				context.fail(unit, failure, resultArtifacts);
				return "run_failed";
			}
			consecutiveMappingFailures = 0;
			recordAttempt(context, unit, attempt, "succeeded", resultArtifacts, undefined, true);
			context.completeUnit(unit, resultArtifacts, {}, attempt);
			const waitResult = await context.waitAfterUnit(unit);
			if (waitResult !== "continue") {
				return waitResult;
			}
			return "succeeded";
		}

		const retryableByPolicy = retryPolicyAllows(retryPolicy, classifiedFailure);
		const immediateRetriesAvailable =
			attempt.phase !== "final_retry" && attempt.attemptIndex < retryPolicy.maxImmediateRetriesPerPoint;
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
				}, []);
				return "run_failed";
			}
			const waitResult = await context.waitAfterUnit(unit);
			if (waitResult !== "continue") {
				return waitResult;
			}
			return "failed";
		}

		context.fail(unit, classifiedFailure.failure, resultArtifacts);
		return "run_failed";
	}

	for (const unit of activeRun.units) {
		const outcome = await runMappingAttempt(unit, { phase: "initial", attemptIndex: 0 });
		if (outcome === "paused" || outcome === "aborted" || outcome === "run_failed") {
			return;
		}
		if (outcome === "failed" && activeRun.spec.stoppingRules?.stopOnError !== false) {
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
			if (outcome === "succeeded" || outcome === "paused" || outcome === "aborted" || outcome === "run_failed") {
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
