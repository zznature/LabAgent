import type { ProcedureId } from "../schemas/index.ts";
import {
	ExperimentProcedureTemplateValidator,
	formatValidationErrors,
	type ExperimentProcedureTemplate,
} from "../schemas/index.ts";
import { experimentProcedureTemplatePath, experimentProcedureTemplatesRoot } from "./layout.ts";
import { listJsonFiles, readJsonFile } from "./storage.ts";

export interface TemplateMatchInput {
	procedureId: ProcedureId;
	sampleId?: string;
	sampleClass?: string;
	intentText?: string;
	intentTags?: string[];
}

export interface TemplateMatchResult {
	status: "matched" | "fallback";
	template?: ExperimentProcedureTemplate;
	matchReason?: string;
	candidateCount: number;
	invalidTemplates: Array<{ fileName: string; issues: string[] }>;
	fallbackReason?: string;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function containsNormalized(values: string[] | undefined, query: string | undefined): boolean {
	if (!values || !query) {
		return false;
	}
	const normalizedQuery = normalize(query);
	return values.some((value) => normalize(value) === normalizedQuery);
}

function intentTextMatches(keywords: string[] | undefined, intentText: string | undefined): boolean {
	if (!keywords || !intentText) {
		return false;
	}
	const normalizedText = normalize(intentText);
	return keywords.some((keyword) => normalizedText.includes(normalize(keyword)));
}

function intentTagsMatch(templateTags: string[] | undefined, intentTags: string[] | undefined): boolean {
	if (!templateTags || !intentTags) {
		return false;
	}
	const normalizedInputTags = new Set(intentTags.map(normalize));
	return templateTags.some((tag) => normalizedInputTags.has(normalize(tag)));
}

function matchRank(template: ExperimentProcedureTemplate, input: TemplateMatchInput): { rank: number; reason: string } | undefined {
	if (template.procedureId !== input.procedureId) {
		return undefined;
	}
	if (containsNormalized(template.match.sampleIds, input.sampleId)) {
		return { rank: 4, reason: "sampleId exact match" };
	}
	if (containsNormalized(template.match.sampleClasses, input.sampleClass)) {
		return { rank: 3, reason: "sampleClass match" };
	}
	if (
		intentTextMatches(template.match.intentKeywords, input.intentText) ||
		intentTagsMatch(template.match.intentTags, input.intentTags)
	) {
		return { rank: 2, reason: "intent keyword/tag match" };
	}
	if (template.match.defaultForProcedure === true) {
		return { rank: 1, reason: "procedure default template" };
	}
	return undefined;
}

export function readExperimentProcedureTemplate(cwd: string, templateId: string): ExperimentProcedureTemplate | undefined {
	return readJsonFile<ExperimentProcedureTemplate>(experimentProcedureTemplatePath(cwd, templateId));
}

export function listExperimentProcedureTemplates(cwd: string): {
	templates: ExperimentProcedureTemplate[];
	invalidTemplates: Array<{ fileName: string; issues: string[] }>;
} {
	const templates: ExperimentProcedureTemplate[] = [];
	const invalidTemplates: Array<{ fileName: string; issues: string[] }> = [];
	for (const fileName of listJsonFiles(experimentProcedureTemplatesRoot(cwd))) {
		const template = readJsonFile<ExperimentProcedureTemplate>(
			experimentProcedureTemplatePath(cwd, fileName.replace(/\.json$/u, "")),
		);
		if (!template) {
			continue;
		}
		if (ExperimentProcedureTemplateValidator.Check(template)) {
			templates.push(template);
		} else {
			invalidTemplates.push({
				fileName,
				issues: formatValidationErrors(ExperimentProcedureTemplateValidator, template),
			});
		}
	}
	return { templates, invalidTemplates };
}

export function findExperimentProcedureTemplate(cwd: string, input: TemplateMatchInput): TemplateMatchResult {
	const { templates, invalidTemplates } = listExperimentProcedureTemplates(cwd);
	const ranked = templates
		.map((template, index) => ({ template, index, match: matchRank(template, input) }))
		.filter(
			(
				candidate,
			): candidate is { template: ExperimentProcedureTemplate; index: number; match: { rank: number; reason: string } } =>
				candidate.match !== undefined,
		)
		.sort((left, right) => right.match.rank - left.match.rank || left.index - right.index);
	const winner = ranked[0];
	if (!winner) {
		return {
			status: "fallback",
			candidateCount: templates.length,
			invalidTemplates,
			fallbackReason: "No workspace template matched; planner should draft independently and ask the user to confirm assumptions.",
		};
	}
	return {
		status: "matched",
		template: winner.template,
		matchReason: winner.match.reason,
		candidateCount: templates.length,
		invalidTemplates,
	};
}
