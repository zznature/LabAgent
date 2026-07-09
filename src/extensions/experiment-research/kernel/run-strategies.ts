import type {
	ExecutionUnit,
	RamanAcquisition,
	RamanEvaluationDecision,
	RamanObservationMetrics,
	RunState,
	RuntimeError,
} from "../schemas/index.ts";
import { evaluateRamanGoodEnough, createSearchEnvelopeFromParameterSearch } from "../planner/evaluate-good-enough.ts";
import type { LiveRamanUnitOptions } from "../runtime/raman/index.ts";
import type { ManagedUnitResult, RunExecutionContext } from "./run-controller.ts";

type UnitOptionsProvider = (unit: ExecutionUnit) => LiveRamanUnitOptions | undefined;

interface ParameterSearchAttemptPlan {
	unit: ExecutionUnit;
	acquisition: RamanAcquisition;
}

function artifactRefsForResult(result: ManagedUnitResult): RunState["artifactRefs"] {
	return result.artifactRefs;
}

function errorForResult(result: Extract<ManagedUnitResult, { status: "failed" }>): RuntimeError {
	return result.error;
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

function createDecisionPauseReason(attemptIndex: number, decision: RamanEvaluationDecision): string {
	return `Parameter search attempt ${attemptIndex + 1} completed and explicit evaluation returned ${decision.decision}.`;
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
			context.pause(unit, createDecisionPauseReason(attemptIndex, decision), []);
			return;
		}
	}

	context.complete();
}

export async function executeMappingRun(context: RunExecutionContext, failureLimit: number): Promise<void> {
	const { activeRun } = context;
	let consecutiveMappingFailures = 0;

	for (const unit of activeRun.units) {
		if (activeRun.abortRequested) {
			context.abortAt(unit);
			return;
		}

		context.markUnitStarted(unit);
		const result = await context.executeUnit(unit);
		const resultArtifacts = artifactRefsForResult(result);

		if (activeRun.pauseRequested || result.status === "paused") {
			context.pause(unit, result.status === "paused" ? result.reason : "operator_requested", resultArtifacts);
			return;
		}

		if (result.status === "failed") {
			const failure = errorForResult(result);
			if (activeRun.spec.stoppingRules?.stopOnError === false) {
				context.recordUnitFailureAndContinue(unit, failure, resultArtifacts);
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
					return;
				}
				continue;
			}

			context.fail(unit, failure, resultArtifacts);
			return;
		}

		consecutiveMappingFailures = 0;
		context.completeUnit(unit, resultArtifacts);
	}

	context.complete();
}
