import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunState } from "../schemas/index.ts";
import { ProcedureSpecValidator, formatValidationErrors } from "../schemas/index.ts";
import {
	abortRun,
	pauseRun,
	pollRun,
	resumeRun,
	startLiveRamanRun,
	startSimulationRun,
} from "../kernel/run-controller.ts";
import { approveAndFreezeProcedureSpec, RunAdmissionError } from "../kernel/run-admission.ts";
import { prepareLiveRun } from "../kernel/prepare-live-run.ts";
import { getRamanLiveRuntime } from "../runtime/raman/index.ts";
import {
	createProcedureProposal,
} from "../store/index.ts";
import {
	ProposalIdParamsSchema,
	RunIdParamsSchema,
	RunProcedureParamsSchema,
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

interface RetryStats {
	failedAttempts: number;
	retriedPoints: number;
	recoveredPoints: number;
	finalFailedPoints: number;
}

interface ErrorSummary {
	errorCode: string;
	count: number;
	latestMessage: string;
	latestTimestamp: string;
}

interface ArtifactPublicationSummary {
	failedCount: number;
	errorCounts: Record<string, number>;
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

function summarizeArtifactPublications(runState: RunState): ArtifactPublicationSummary {
	const failedArtifacts = runState.artifactRefs.filter(
		(artifact) => artifact.metadata?.publicationStatus === "failed",
	);
	const errorCounts: Record<string, number> = {};
	for (const artifact of failedArtifacts) {
		const publicationError = artifact.metadata?.publicationError;
		const errorCode = typeof publicationError === "object" && publicationError !== null && "errorCode" in publicationError &&
			typeof publicationError.errorCode === "string"
			? publicationError.errorCode
			: "artifact_publication_failed";
		errorCounts[errorCode] = (errorCounts[errorCode] ?? 0) + 1;
	}
	return { failedCount: failedArtifacts.length, errorCounts };
}

function summarizeRetries(runState: RunState): RetryStats {
	const attempts = runState.pointAttempts ?? [];
	const attemptsByPoint = new Map<string, typeof attempts>();
	for (const attempt of attempts) {
		const pointAttempts = attemptsByPoint.get(attempt.pointUnitId) ?? [];
		pointAttempts.push(attempt);
		attemptsByPoint.set(attempt.pointUnitId, pointAttempts);
	}
	const pointAttempts = [...attemptsByPoint.values()];
	return {
		failedAttempts: attempts.filter((attempt) => attempt.status === "failed").length,
		retriedPoints: pointAttempts.filter((records) => records.length > 1).length,
		recoveredPoints: pointAttempts.filter(
			(records) => records.some((attempt) => attempt.status === "failed") && records.some((attempt) => attempt.status === "succeeded" && attempt.finalForPoint),
		).length,
		finalFailedPoints: pointAttempts.filter(
			(records) => records.some((attempt) => attempt.status === "failed" && attempt.finalForPoint),
		).length,
	};
}

function dominantError(runState: RunState): Omit<ErrorSummary, "latestTimestamp"> | undefined {
	const counts = new Map<string, ErrorSummary>();
	for (const attempt of runState.pointAttempts ?? []) {
		if (attempt.status !== "failed" || !attempt.errorCode) continue;
		const current = counts.get(attempt.errorCode);
		const latestTimestamp = attempt.timestamp;
		counts.set(attempt.errorCode, {
			errorCode: attempt.errorCode,
			count: (current?.count ?? 0) + 1,
			latestMessage: !current || latestTimestamp >= current.latestTimestamp
				? attempt.errorMessage ?? attempt.errorCode
				: current.latestMessage,
			latestTimestamp: !current || latestTimestamp >= current.latestTimestamp ? latestTimestamp : current.latestTimestamp,
		});
	}
	const dominant = [...counts.values()].sort((left, right) =>
		right.count - left.count || right.latestTimestamp.localeCompare(left.latestTimestamp)
	)[0];
	if (!dominant && runState.errorState) {
		return {
			errorCode: runState.errorState.errorCode,
			count: 1,
			latestMessage: runState.errorState.message,
		};
	}
	return dominant && {
		errorCode: dominant.errorCode,
		count: dominant.count,
		latestMessage: dominant.latestMessage,
	};
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
			: runState.errorState
				? `, error ${runState.errorState.errorCode}: ${runState.errorState.message}`
				: "";
	const retryStats = summarizeRetries(runState);
	const retryText = `, ${retryStats.retriedPoints} retried, ${retryStats.recoveredPoints} recovered, ${retryStats.finalFailedPoints} final failures`;
	const repeatedError = dominantError(runState);
	const errorText = repeatedError
		? `, dominant error ${repeatedError.errorCode} x${repeatedError.count}: ${repeatedError.latestMessage}`
		: "";
	const publicationSummary = summarizeArtifactPublications(runState);
	const publicationText = publicationSummary.failedCount > 0
		? `, ${publicationSummary.failedCount} artifact publication failed`
		: "";
	return `Run ${runState.runId} is ${runState.status}: ${progressSummary(runState)}${retryText}, ${artifactText}${publicationText}${errorText}${reasonText}.`;
}

function runSummaryState(runState: RunState): Record<string, unknown> {
	return {
		runId: runState.runId,
		experimentId: runState.experimentId,
		procedureSpecId: runState.procedureSpecId,
		status: runState.status,
		progress: runState.progress,
		currentUnit: runState.currentUnit,
		startedAt: runState.startedAt,
		updatedAt: runState.updatedAt,
		endedAt: runState.endedAt,
		summary: {
			status: runState.status,
			progressText: progressSummary(runState),
			artifactCount: runState.artifactRefs.length,
			artifactCountsByKind: summarizeArtifacts(runState),
			artifactPublications: summarizeArtifactPublications(runState),
			retryStats: summarizeRetries(runState),
			dominantError: dominantError(runState),
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
		const mode = params.executionMode ?? "simulation";
		const runtime = mode === "live-supervised" ? getRamanLiveRuntime(ctx.cwd) : undefined;
		if (mode === "live-supervised" && !runtime) {
			return error("No live Raman runtime is registered for this workspace.", "live_runtime_unavailable", {
				executionMode: mode,
			});
		}

		try {
			let verifiedAdmission = params.admission;
			if (mode === "live-supervised" && runtime) {
				const preparation = await prepareLiveRun(params.spec, runtime);
				if (preparation.contractIssues.length > 0 || preparation.forbiddenRisks.length > 0) {
					throw new RunAdmissionError(
						"Live supervised execution requires all preflight risks to be resolved before approval and start.",
						"preflight_forbidden",
						{ contractIssues: preparation.contractIssues, forbiddenRisks: preparation.forbiddenRisks },
					);
				}
				verifiedAdmission = {
					preflightReady: preparation.livePreflight.preflightReady,
					controlAvailable: preparation.livePreflight.controlAvailable,
				};
				if (preparation.livePreflight.preflightReady && preparation.livePreflight.controlAvailable) {
					if (!preparation.anchorValidation.valid) {
						throw new RunAdmissionError(
							"Live supervised execution requires the current stage anchor to match the approved ProcedureSpec.",
							"preflight_stage_anchor_invalid",
							preparation.anchorValidation.details,
						);
					}
				}
			}
			const admitted = approveAndFreezeProcedureSpec({
				cwd: ctx.cwd,
				proposalId: params.proposalId,
				spec: params.spec,
				mode,
				admission: verifiedAdmission,
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

export const resumeRunTool = {
	name: "resume_run",
	label: "Resume Run",
	description: "Resume a paused bounded run with the same runId and new immutable attempts.",
	promptSnippet: "Resume a paused bounded run without replacing its runId or previous attempt artifacts",
	promptGuidelines: ["Resume only a paused run; accepted units are skipped and unfinished units receive new attempts."],
	parameters: RunIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunIdParams, _signal, _onUpdate, ctx) {
		try {
			const runState = resumeRun(ctx.cwd, params.runId);
			return success(`Run ${params.runId} resumed.`, runState);
		} catch {
			return error(`Run ${params.runId} is not paused or cannot be resumed.`, "run_not_paused");
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
