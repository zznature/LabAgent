import { describe, expect, it } from "vitest";
import {
	createSearchEnvelopeFromParameterSearch,
	DEFAULT_RAMAN_EVALUATION_CONFIG,
	evaluateRamanGoodEnough,
} from "../planner/evaluate-good-enough.ts";
import {
	RamanEvaluationConfigValidator,
	RamanEvaluationDecisionValidator,
	RamanEvaluationMetricsValidator,
	RamanSearchEnvelopeValidator,
} from "../schemas/index.ts";

describe("experiment research good-enough Raman rules", () => {
	it("accepts the default evaluation config and metrics schema", () => {
		const metrics = {
			attemptIndex: 0,
			current: {
				autofocusConfidence: 0.82,
				saturated: false,
				snr: 11,
				targetPeakBaselineRatio: 1.4,
			},
			recentObservations: [],
		};

		expect(RamanEvaluationConfigValidator.Check(DEFAULT_RAMAN_EVALUATION_CONFIG)).toBe(true);
		expect(DEFAULT_RAMAN_EVALUATION_CONFIG.autofocusConfidenceMin).toBe(0.15);
		expect(RamanEvaluationMetricsValidator.Check(metrics)).toBe(true);
	});

	it("returns acceptable when all explicit thresholds and repeat consistency pass", () => {
		const decision = evaluateRamanGoodEnough({
			attemptIndex: 2,
			current: {
				autofocusConfidence: 0.91,
				saturated: false,
				snr: 12,
				targetPeakBaselineRatio: 1.5,
			},
			recentObservations: [
				{
					autofocusConfidence: 0.81,
					saturated: false,
					snr: 9,
					targetPeakBaselineRatio: 1.3,
				},
				{
					autofocusConfidence: 0.74,
					saturated: false,
					snr: 8.5,
					targetPeakBaselineRatio: 1.27,
				},
			],
		});

		expect(decision.decision).toBe("acceptable");
		expect(decision.consistencyCheck.passed).toBe(true);
		expect(RamanEvaluationDecisionValidator.Check(decision)).toBe(true);
	});

	it("returns continue_search_within_envelope when checks fail but search budget remains", () => {
		const envelope = createSearchEnvelopeFromParameterSearch({
			maxAttempts: 4,
			laserPowerPercentValues: [0.01, 0.1, 1],
			integrationTimeMs: { min: 1_000, max: 5_000 },
			accumulations: [1, 2],
		});

		const decision = evaluateRamanGoodEnough(
			{
				attemptIndex: 1,
				current: {
					autofocusConfidence: 0.62,
					saturated: false,
					snr: 6.5,
					targetPeakBaselineRatio: 1.1,
				},
				recentObservations: [
					{
						autofocusConfidence: 0.6,
						saturated: false,
						snr: 7,
						targetPeakBaselineRatio: 1.15,
					},
				],
			},
			envelope,
		);

		expect(decision.decision).toBe("continue_search_within_envelope");
		expect(decision.reasons.join(" ")).toContain("Search can continue within the approved envelope");
		expect(RamanSearchEnvelopeValidator.Check(envelope)).toBe(true);
	});

	it("returns stop_and_request_user_decision when the search budget is exhausted", () => {
		const envelope = createSearchEnvelopeFromParameterSearch({
			maxAttempts: 2,
			laserPowerPercentValues: [0.01, 0.1, 1],
		});

		const decision = evaluateRamanGoodEnough(
			{
				attemptIndex: 1,
				current: {
					autofocusConfidence: 0.61,
					saturated: true,
					snr: 5,
					targetPeakBaselineRatio: 1.05,
				},
				recentObservations: [
					{
						autofocusConfidence: 0.64,
						saturated: false,
						snr: 6.2,
						targetPeakBaselineRatio: 1.08,
					},
				],
			},
			envelope,
		);

		expect(decision.decision).toBe("stop_and_request_user_decision");
		expect(decision.consistencyCheck.passed).toBe(false);
		expect(decision.reasons.join(" ")).toContain("Search budget exhausted");
	});

	it("allows config overrides to change the explicit thresholds deterministically", () => {
		const decision = evaluateRamanGoodEnough(
			{
				attemptIndex: 0,
				current: {
					autofocusConfidence: 0.68,
					saturated: false,
					snr: 7.5,
					targetPeakBaselineRatio: 1.2,
				},
				recentObservations: [],
			},
			undefined,
			{
				autofocusConfidenceMin: 0.65,
				snrMin: 7,
				targetPeakBaselineRatioMin: 1.15,
				repeatWindowSize: 1,
				repeatPassesRequired: 1,
			},
		);

		expect(decision.decision).toBe("acceptable");
	});
});
