import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunState } from "../schemas/index.ts";
import { ProcedureSpecValidator, formatValidationErrors } from "../schemas/index.ts";
import {
	abortRun,
	pauseRun,
	pollRun,
	startLiveRamanRun,
	startSimulationRun,
} from "../kernel/run-controller.ts";
import { approveAndFreezeProcedureSpec, RunAdmissionError } from "../kernel/run-admission.ts";
import { getRamanLiveRuntime } from "../runtime/raman/index.ts";
import {
	createProcedureProposal,
} from "../store/index.ts";
import {
	ProposalIdParamsSchema,
	RunIdParamsSchema,
	RunProcedureParamsSchema,
	type ExecutionMode,
	type ProposalIdParams,
	type RunIdParams,
	type RunProcedureParams,
} from "./params.ts";

interface RuntimeToolDetails {
	status: "success" | "warning" | "error";
	summary: string;
	runId?: string;
	proposalId?: string;
	errorCode?: string;
	retrySafe?: boolean;
	needsOperator?: boolean;
	safeToResume?: boolean;
	stateAfter: Record<string, unknown>;
}

function serializeRunState(runState: RunState): Record<string, unknown> {
	return {
		runId: runState.runId,
		experimentId: runState.experimentId,
		procedureSpecId: runState.procedureSpecId,
		status: runState.status,
		progress: runState.progress,
		currentUnit: runState.currentUnit,
		artifactRefs: runState.artifactRefs,
		pauseReason: runState.pauseReason,
		abortReason: runState.abortReason,
		errorState: runState.errorState,
		qualityState: runState.qualityState,
		pointAttempts: runState.pointAttempts,
		startedAt: runState.startedAt,
		updatedAt: runState.updatedAt,
		endedAt: runState.endedAt,
	};
}

function summarizeArtifacts(runState: RunState): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const artifact of runState.artifactRefs) {
		counts[artifact.kind] = (counts[artifact.kind] ?? 0) + 1;
	}
	return counts;
}

function progressSummary(runState: RunState): string {
	const progress = runState.progress;
	const total = progress.totalUnits;
	const failed = progress.failedUnits ?? 0;
	const unitKind = progress.unitKind ?? "unit";
	const completedText =
		total === undefined
			? `${progress.completedUnits} ${unitKind} units completed`
			: `${progress.completedUnits}/${total} ${unitKind} units completed`;
	const currentText =
		runState.currentUnit === undefined
			? "no current unit"
			: `current unit index ${runState.currentUnit.index}`;
	return `${completedText}, ${failed} failed, ${currentText}`;
}

function runSummaryText(runState: RunState): string {
	const artifacts = runState.artifactRefs;
	const latestArtifact = artifacts.at(-1);
	const artifactText =
		latestArtifact === undefined
			? "no artifacts yet"
			: `${artifacts.length} artifacts, latest ${latestArtifact.kind}`;
	const reasonText = runState.pauseReason
		? `, pause reason: ${runState.pauseReason}`
		: runState.abortReason
			? `, abort reason: ${runState.abortReason}`
			: "";
	return `Run ${runState.runId} is ${runState.status}: ${progressSummary(runState)}, ${artifactText}${reasonText}.`;
}

function runSummaryState(runState: RunState): Record<string, unknown> {
	return {
		...serializeRunState(runState),
		summary: {
			status: runState.status,
			progressText: progressSummary(runState),
			artifactCount: runState.artifactRefs.length,
			artifactCountsByKind: summarizeArtifacts(runState),
			latestArtifact: runState.artifactRefs.at(-1),
			errorState: runState.errorState,
			pauseReason: runState.pauseReason,
			abortReason: runState.abortReason,
		},
	};
}

function success(summary: string, runState: RunState): { content: [{ type: "text"; text: string }]; details: RuntimeToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: runState.status === "paused" ? "warning" : "success",
			summary,
			runId: runState.runId,
			stateAfter: serializeRunState(runState),
		},
	};
}

function error(summary: string, errorCode: string, stateAfter: Record<string, unknown> = {}): { content: [{ type: "text"; text: string }]; details: RuntimeToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "error",
			summary,
			errorCode,
			retrySafe: true,
			needsOperator: false,
			safeToResume: false,
			stateAfter,
		},
	};
}

function resolveExecutionMode(params: { executionMode?: ExecutionMode }): ExecutionMode {
	return params.executionMode ?? "simulation";
}

export const runProcedureTool = {
	name: "run_procedure",
	label: "Run Procedure",
	description: "Deprecated direct run entrypoint. Use propose_run and approve_and_start_run instead.",
	promptSnippet: "Deprecated: direct run entrypoint is blocked; use propose_run and approve_and_start_run",
	promptGuidelines: [
		"Do not use run_procedure directly; the approval gate requires propose_run followed by approve_and_start_run.",
	],
	parameters: RunProcedureParamsSchema,
	executionMode: "sequential",
	async execute() {
		return error(
			"Direct execution is blocked. Use propose_run and approve_and_start_run so the spec is explicitly approved and frozen first.",
			"approval_required",
		);
	},
} satisfies ToolDefinition<typeof RunProcedureParamsSchema, RuntimeToolDetails>;

export const proposeRunTool = {
	name: "propose_run",
	label: "Propose Run",
	description: "Validate a ProcedureSpec proposal and persist it for explicit approval.",
	promptSnippet: "Propose a bounded run and get a proposalId that requires confirmation",
	promptGuidelines: [
		"Use propose_run to create a bounded run proposal before any execution.",
		"Do not call approve_and_start_run with a modified spec; the approved spec must match the proposal exactly.",
	],
	parameters: RunProcedureParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunProcedureParams, _signal, _onUpdate, ctx) {
		if (!ProcedureSpecValidator.Check(params.spec)) {
			return error(
				`ProcedureSpec failed validation: ${formatValidationErrors(ProcedureSpecValidator, params.spec).join("; ")}`,
				"invalid_procedure_spec",
			);
		}
		const proposal = createProcedureProposal(ctx.cwd, params.spec);
		return {
			content: [{ type: "text", text: `Run proposal ${proposal.proposalId} created.` }],
			details: {
				status: "success",
				summary: `Run proposal ${proposal.proposalId} created and awaiting approval.`,
				proposalId: proposal.proposalId,
				stateAfter: {
					proposalId: proposal.proposalId,
					specHash: proposal.specHash,
					requiresConfirmation: true,
					status: proposal.status,
					procedureSpecId: proposal.procedureSpecId,
					supportedExecutionModes: ["simulation", "live-supervised"],
					templateApplication: params.templateApplication
						? {
							applied: true,
							templateId: params.templateApplication.templateId,
							templateVersion: params.templateApplication.templateVersion,
							matchReason: params.templateApplication.matchReason,
							inheritedFields: params.templateApplication.inheritedFields,
							overriddenFields: params.templateApplication.overriddenFields ?? [],
							notes: params.templateApplication.notes ?? [],
						}
						: {
							applied: false,
							note: "No ExperimentProcedureTemplate metadata was supplied.",
						},
				},
			},
		};
	},
} satisfies ToolDefinition<typeof RunProcedureParamsSchema, RuntimeToolDetails>;

export const approveAndStartRunTool = {
	name: "approve_and_start_run",
	label: "Approve And Start Run",
	description: "Approve a previously proposed ProcedureSpec, freeze it, and start the bounded run.",
	promptSnippet: "Approve a proposalId and start the frozen bounded run",
	promptGuidelines: [
		"Use this only after propose_run.",
		"The spec passed here must match the stored proposal exactly or the run must be rejected.",
	],
	parameters: ProposalIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProposalIdParams, _signal, _onUpdate, ctx) {
		const mode = resolveExecutionMode(params);
		if (mode === "live-supervised" && !getRamanLiveRuntime(ctx.cwd)) {
			return error("No live Raman runtime is registered for this workspace.", "live_runtime_unavailable", {
				executionMode: mode,
			});
		}

		try {
			const admitted = approveAndFreezeProcedureSpec({
				cwd: ctx.cwd,
				proposalId: params.proposalId,
				spec: params.spec,
				mode,
				admission: params.admission,
			});
			const runState =
				mode === "live-supervised"
					? startLiveRamanRun(ctx.cwd, admitted.frozenSpec)
					: startSimulationRun(ctx.cwd, admitted.frozenSpec, params.simulation);
			const modeLabel = mode === "live-supervised" ? "live supervised" : "simulation";
			return success(`${modeLabel} run ${runState.runId} started from approved proposal ${admitted.approvedProposal.proposalId}.`, runState);
		} catch (cause) {
			if (cause instanceof RunAdmissionError) {
				return error(cause.message, cause.code, cause.stateAfter);
			}
			const message = cause instanceof Error ? cause.message : String(cause);
			const errorCode =
				mode === "live-supervised"
					? "live_runtime_start_failed"
					: "simulation_start_failed";
			return error(message, errorCode, { executionMode: mode });
		}
	},
} satisfies ToolDefinition<typeof ProposalIdParamsSchema, RuntimeToolDetails>;

export const pollRunTool = {
	name: "poll_run",
	label: "Poll Run",
	description: "Return the latest persisted bounded run snapshot.",
	promptSnippet: "Poll the latest state of a bounded run by runId",
	promptGuidelines: ["Use this to monitor status transitions after approve_and_start_run, pause_run, or abort_run."],
	parameters: RunIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunIdParams, _signal, _onUpdate, ctx) {
		const runState = pollRun(ctx.cwd, params.runId);
		if (!runState) {
			return error(`Run ${params.runId} was not found.`, "run_not_found");
		}
		return success(runSummaryText(runState), runState);
	},
} satisfies ToolDefinition<typeof RunIdParamsSchema, RuntimeToolDetails>;

export const summarizeRunTool = {
	name: "summarize_run",
	label: "Summarize Run",
	description: "Return a compact operator-facing summary of a bounded run snapshot.",
	promptSnippet: "Summarize run progress, failures, pause/abort reason, and artifact counts",
	promptGuidelines: [
		"Use this when the user asks how many points finished, what failed, or where run outputs are.",
		"Use poll_run for raw status checks and summarize_run for operator-facing progress summaries.",
	],
	parameters: RunIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunIdParams, _signal, _onUpdate, ctx) {
		const runState = pollRun(ctx.cwd, params.runId);
		if (!runState) {
			return error(`Run ${params.runId} was not found.`, "run_not_found");
		}
		const summary = runSummaryText(runState);
		return {
			content: [{ type: "text", text: summary }],
			details: {
				status: runState.status === "paused" ? "warning" : "success",
				summary,
				runId: runState.runId,
				stateAfter: runSummaryState(runState),
			},
		};
	},
} satisfies ToolDefinition<typeof RunIdParamsSchema, RuntimeToolDetails>;

export const pauseRunTool = {
	name: "pause_run",
	label: "Pause Run",
	description: "Request that an active bounded run pause at the next safe unit boundary.",
	promptSnippet: "Request a pause for a running bounded run",
	promptGuidelines: ["Pause takes effect at the next safe unit boundary, not in the middle of a unit."],
	parameters: RunIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunIdParams, _signal, _onUpdate, ctx) {
		try {
			const runState = pauseRun(ctx.cwd, params.runId);
			return success(`Pause requested for run ${params.runId}.`, runState);
		} catch {
			return error(`Run ${params.runId} is not active.`, "run_not_active");
		}
	},
} satisfies ToolDefinition<typeof RunIdParamsSchema, RuntimeToolDetails>;

export const abortRunTool = {
	name: "abort_run",
	label: "Abort Run",
	description: "Request that an active bounded run abort at the next safe unit boundary.",
	promptSnippet: "Request an abort for a running bounded run",
	promptGuidelines: ["Abort takes effect at the next safe unit boundary, not in the middle of a unit."],
	parameters: RunIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunIdParams, _signal, _onUpdate, ctx) {
		try {
			const runState = abortRun(ctx.cwd, params.runId);
			return success(`Abort requested for run ${params.runId}.`, runState);
		} catch {
			return error(`Run ${params.runId} is not active.`, "run_not_active");
		}
	},
} satisfies ToolDefinition<typeof RunIdParamsSchema, RuntimeToolDetails>;
