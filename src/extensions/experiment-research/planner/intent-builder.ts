import { randomUUID } from "node:crypto";
import type { ExperimentIntent } from "../schemas/experiment-intent.ts";

export interface ExperimentIntentBuilderInput {
	intentId?: string;
	experimentId?: string;
	objective: string;
	hypothesis?: string;
	question?: string;
	constraints?: Record<string, unknown>;
	successCriteria?: string[];
	evidenceRefs?: string[];
	notes?: string;
}

function generatedId(prefix: string): string {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function buildExperimentIntent(input: ExperimentIntentBuilderInput): ExperimentIntent {
	return {
		intentId: input.intentId ?? generatedId("intent"),
		experimentId: input.experimentId ?? generatedId("exp"),
		objective: input.objective,
		hypothesis: input.hypothesis,
		question: input.question,
		constraints: input.constraints,
		successCriteria: input.successCriteria,
		evidenceRefs: input.evidenceRefs,
		notes: input.notes,
	};
}
