import type {
	RamanBooleanCheck,
	RamanConsistencyCheck,
	RamanEvaluationConfig,
	RamanEvaluationDecision,
	RamanEvaluationMetrics,
	RamanObservationMetrics,
	RamanSearchEnvelope,
	RamanThresholdCheck,
} from "../schemas/index.ts";

export const DEFAULT_RAMAN_EVALUATION_CONFIG: RamanEvaluationConfig = {
	autofocusConfidenceMin: 0.15,
	snrMin: 8,
	targetPeakBaselineRatioMin: 1.25,
	repeatWindowSize: 3,
	repeatPassesRequired: 2,
};

export interface RamanEvaluationConfigOverrides {
	autofocusConfidenceMin?: number;
	snrMin?: number;
	targetPeakBaselineRatioMin?: number;
	repeatWindowSize?: number;
	repeatPassesRequired?: number;
}

function buildThresholdChecks(
	metrics: RamanObservationMetrics,
	config: RamanEvaluationConfig,
): RamanThresholdCheck[] {
	return [
		{
			name: "autofocus_confidence",
			passed: metrics.autofocusConfidence >= config.autofocusConfidenceMin,
			observed: metrics.autofocusConfidence,
			threshold: config.autofocusConfidenceMin,
		},
		{
			name: "snr",
			passed: metrics.snr >= config.snrMin,
			observed: metrics.snr,
			threshold: config.snrMin,
		},
		{
			name: "target_peak_baseline_ratio",
			passed: metrics.targetPeakBaselineRatio >= config.targetPeakBaselineRatioMin,
			observed: metrics.targetPeakBaselineRatio,
			threshold: config.targetPeakBaselineRatioMin,
		},
	];
}

function buildBooleanChecks(metrics: RamanObservationMetrics): RamanBooleanCheck[] {
	return [
		{
			name: "not_saturated",
			passed: !metrics.saturated,
			observed: metrics.saturated,
		},
	];
}

function observationPassesAllChecks(metrics: RamanObservationMetrics, config: RamanEvaluationConfig): boolean {
	return metrics.autofocusConfidence >= config.autofocusConfidenceMin &&
		!metrics.saturated &&
		metrics.snr >= config.snrMin &&
		metrics.targetPeakBaselineRatio >= config.targetPeakBaselineRatioMin;
}

function buildConsistencyCheck(
	metrics: RamanEvaluationMetrics,
	config: RamanEvaluationConfig,
): RamanConsistencyCheck {
	const window = [metrics.current, ...metrics.recentObservations].slice(0, config.repeatWindowSize);
	const passesObserved = window.filter((observation) => observationPassesAllChecks(observation, config)).length;
	return {
		name: "repeat_consistency",
		passed: passesObserved >= config.repeatPassesRequired,
		windowSize: config.repeatWindowSize,
		passesRequired: config.repeatPassesRequired,
		passesObserved,
	};
}

function mergeConfig(overrides?: RamanEvaluationConfigOverrides): RamanEvaluationConfig {
	return {
		...DEFAULT_RAMAN_EVALUATION_CONFIG,
		...overrides,
	};
}

function withinSearchBudget(metrics: RamanEvaluationMetrics, envelope?: RamanSearchEnvelope): boolean {
	if (!envelope) {
		return false;
	}
	return metrics.attemptIndex + 1 < envelope.maxAttempts;
}

function shouldContinueSearch(
	thresholdChecks: RamanThresholdCheck[],
	booleanChecks: RamanBooleanCheck[],
	consistencyCheck: RamanConsistencyCheck,
	metrics: RamanEvaluationMetrics,
	envelope?: RamanSearchEnvelope,
): boolean {
	const currentMeasurementRecoverable =
		thresholdChecks.some((check) => !check.passed) || booleanChecks.some((check) => !check.passed);
	return (currentMeasurementRecoverable || !consistencyCheck.passed) && withinSearchBudget(metrics, envelope);
}

function buildReasons(
	decision: RamanEvaluationDecision["decision"],
	thresholdChecks: RamanThresholdCheck[],
	booleanChecks: RamanBooleanCheck[],
	consistencyCheck: RamanConsistencyCheck,
	metrics: RamanEvaluationMetrics,
	envelope?: RamanSearchEnvelope,
): string[] {
	const failedChecks = [
		...thresholdChecks.filter((check) => !check.passed).map((check) => `${check.name} below threshold`),
		...booleanChecks.filter((check) => !check.passed).map((check) => `${check.name} failed`),
	];

	if (decision === "acceptable") {
		return ["All explicit Raman quality checks passed.", "Repeat consistency rule passed within the configured window."];
	}

	if (decision === "continue_search_within_envelope") {
		return [
			...failedChecks,
			`Search can continue within the approved envelope before attempt ${envelope?.maxAttempts}.`,
		];
	}

	return [
		...failedChecks,
		consistencyCheck.passed
			? "Current quality checks failed after repeat consistency had already been satisfied; request operator judgment."
			: `Search budget exhausted at attempt ${metrics.attemptIndex + 1}${envelope ? ` of ${envelope.maxAttempts}` : ""}.`,
	];
}

export function evaluateRamanGoodEnough(
	metrics: RamanEvaluationMetrics,
	envelope?: RamanSearchEnvelope,
	overrides?: RamanEvaluationConfigOverrides,
): RamanEvaluationDecision {
	const config = mergeConfig(overrides);
	const thresholdChecks = buildThresholdChecks(metrics.current, config);
	const booleanChecks = buildBooleanChecks(metrics.current);
	const consistencyCheck = buildConsistencyCheck(metrics, config);

	const allCurrentChecksPassed =
		thresholdChecks.every((check) => check.passed) && booleanChecks.every((check) => check.passed);

	const decision: RamanEvaluationDecision["decision"] =
		allCurrentChecksPassed && consistencyCheck.passed
			? "acceptable"
			: shouldContinueSearch(thresholdChecks, booleanChecks, consistencyCheck, metrics, envelope)
				? "continue_search_within_envelope"
				: "stop_and_request_user_decision";

	return {
		decision,
		reasons: buildReasons(decision, thresholdChecks, booleanChecks, consistencyCheck, metrics, envelope),
		thresholdChecks,
		booleanChecks,
		consistencyCheck,
		envelope,
	};
}

export function createSearchEnvelopeFromParameterSearch(
	parameterSearch: {
		maxAttempts: number;
		laserPowerPercentValues?: number[];
		integrationTimeMs?: { min: number; max: number };
		accumulations?: number[];
	},
): RamanSearchEnvelope {
	const allowedParameters = [
		parameterSearch.laserPowerPercentValues ? "laserPowerPercent" : undefined,
		parameterSearch.integrationTimeMs ? "integrationTimeMs" : undefined,
		parameterSearch.accumulations ? "accumulations" : undefined,
	].filter((value): value is RamanSearchEnvelope["allowedParameters"][number] => value !== undefined);

	return {
		allowedParameters,
		maxAttempts: parameterSearch.maxAttempts,
		forbiddenExpansions: [
			"Do not widen the approved search envelope.",
			"Do not modify autofocus ROI or Z window during the search.",
			"Do not expand into mapping without a new approved bounded run.",
		],
	};
}
