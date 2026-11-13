import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PointAttemptRecord, RunState } from "../schemas/index.ts";
import { ProcedureSpecValidator, formatValidationErrors } from "../schemas/index.ts";
import {
	abortRun,
	pauseRun,
	planRunResume,
	pollRun,
	resumeRun,
	RunResumeError,
	startLiveRamanRun,
	startSimulationRun,
} from "../kernel/run-controller.ts";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import { approveAndFreezeProcedureSpec, RunAdmissionError } from "../kernel/run-admission.ts";
import { summarizeProcedureProposal } from "../planner/procedure-spec-builder.ts";
import { describeAutofocusRoi, resolveAutofocusRoiTemplate } from "../planner/autofocus-roi.ts";
import type { AutofocusRoiSource } from "../store/proposal-store.ts";
import { getRamanLiveRuntime } from "../runtime/raman/index.ts";
import {
	createProcedureProposal,
	findProcedureProposal,
	supersedeProcedureProposal,
} from "../store/index.ts";
import {
	ProposalIdParamsSchema,
	ResumeRunParamsSchema,
	ReviseProposalParamsSchema,
	RunIdParamsSchema,
	RunProcedureParamsSchema,
	type ProposalIdParams,
	type ResumeRunParams,
	type ReviseProposalParams,
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
		lastAcceptedFocusZUm: runState.lastAcceptedFocusZUm,
		focusCenterPolicy: runState.focusCenterPolicy,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 7386 JSON merge patch: nested objects merge, null deletes, arrays and scalars replace. */
function applyMergePatch(target: unknown, patch: Record<string, unknown>): unknown {
	const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete base[key];
			continue;
		}
		base[key] = isPlainObject(value) ? applyMergePatch(base[key], value) : value;
	}
	return base;
}

function latestFailedAttempt(runState: RunState): PointAttemptRecord | undefined {
	return runState.pointAttempts?.filter((attempt) => attempt.status === "failed").at(-1);
}

function failureText(runState: RunState): string {
	if (runState.errorState) {
		return ` Run failure ${runState.errorState.errorCode}: ${runState.errorState.message}`;
	}
	const attempt = latestFailedAttempt(runState);
	if (!attempt) {
		return "";
	}
	const cause = [attempt.errorCode, attempt.failureReason].filter((part) => part !== undefined).join("/");
	const detail = attempt.message ? `: ${attempt.message}` : "";
	return ` Latest point failure on ${attempt.pointUnitId} (${attempt.phase} attempt ${attempt.attemptIndex}) ${cause}${detail}`;
}

/**
 * One-line run report used both by summarize_run/poll_run and by the terminal-run push,
 * so the operator never has to poll for a reason the system already computed.
 */
export function runSummaryText(runState: RunState): string {
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
	return `Run ${runState.runId} is ${runState.status}: ${progressSummary(runState)}, ${artifactText}${reasonText}.${failureText(runState)}`;
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

function notActiveError(cwd: string, runId: string): { content: [{ type: "text"; text: string }]; details: RuntimeToolDetails } {
	const runState = pollRun(cwd, runId);
	if (!runState) {
		return error(`Run ${runId} was not found.`, "run_not_found");
	}
	return error(
		`Run ${runId} is not active; current status is ${runState.status}.${failureText(runState)}`,
		"run_not_active",
		runSummaryState(runState),
	);
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
		"Quote the returned proposalId and specHash to the operator; never ask the operator to look the specHash up elsewhere.",
		"Include the returned actual autofocus ROI coordinates and source when presenting the proposal; reuse selected workspace template coordinates unless the user explicitly overrides them.",
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
		let spec = params.spec;
		let autofocusRoiSource: AutofocusRoiSource | undefined;
		try {
			({ spec, source: autofocusRoiSource } = resolveAutofocusRoiTemplate(ctx.cwd, spec, params.templateApplication));
			compileProcedureSpec(spec);
		} catch (cause) {
			return error(
				`ProcedureSpec failed executable validation: ${cause instanceof Error ? cause.message : String(cause)}`,
				"invalid_procedure_spec",
			);
		}
		const preview = summarizeProcedureProposal(spec);
		const proposal = createProcedureProposal(ctx.cwd, spec, undefined, autofocusRoiSource);
		const summary = `Run proposal ${proposal.proposalId} created and awaiting approval. specHash=${proposal.specHash}\n${describeAutofocusRoi(spec, autofocusRoiSource)}`;
		return {
			content: [{ type: "text", text: summary }],
			details: {
				status: "success",
				summary,
				proposalId: proposal.proposalId,
				stateAfter: {
					proposalId: proposal.proposalId,
					specHash: proposal.specHash,
					status: proposal.status,
					procedureSpecId: proposal.procedureSpecId,
					unitCount: preview.unitCount,
					estimatedRuntimeMs: preview.estimatedRuntimeMs,
					requiresConfirmation: preview.requiresConfirmation,
					risks: preview.risks,
					limits: preview.limits,
					mappingAutofocus: preview.mappingAutofocus,
					autofocusRoi: { ...spec.domain.raman.autofocus.roi },
					autofocusRoiSource,
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

export const reviseProposalTool = {
	name: "revise_proposal",
	label: "Revise Proposal",
	description: "Apply a merge patch to a pending proposal's ProcedureSpec and create a replacement proposal.",
	promptSnippet: "Revise a pending proposal with a merge patch instead of re-sending the whole spec",
	promptGuidelines: [
		"Use this to change parameters on a pending proposal; do not re-send a full ProcedureSpec through propose_run for a tweak.",
		"The patch is a JSON merge patch against the stored spec; null removes a key.",
		"A revision never inherits approval: quote the new proposalId and specHash and get the operator to acknowledge them.",
	],
	parameters: ReviseProposalParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ReviseProposalParams, _signal, _onUpdate, ctx) {
		const proposal = findProcedureProposal(ctx.cwd, params.proposalId);
		if (!proposal) {
			return error(`Proposal ${params.proposalId} was not found.`, "proposal_not_found");
		}
		if (proposal.status !== "proposed") {
			return error(
				`Proposal ${params.proposalId} is ${proposal.status} and can no longer be revised.`,
				"proposal_not_pending",
				{ status: proposal.status, supersededBy: proposal.supersededBy },
			);
		}

		const revisedSpec = applyMergePatch(proposal.spec, params.patch);
		if (!ProcedureSpecValidator.Check(revisedSpec)) {
			return error(
				`Revised ProcedureSpec failed validation: ${formatValidationErrors(ProcedureSpecValidator, revisedSpec).join("; ")}`,
				"invalid_procedure_spec",
			);
		}
		try {
			compileProcedureSpec(revisedSpec);
		} catch (cause) {
			return error(
				`Revised ProcedureSpec failed executable validation: ${cause instanceof Error ? cause.message : String(cause)}`,
				"invalid_procedure_spec",
			);
		}

		const preview = summarizeProcedureProposal(revisedSpec);
		const roiUnchanged = (["x", "y", "width", "height"] as const).every(
			(key) => revisedSpec.domain.raman.autofocus.roi[key] === proposal.spec.domain.raman.autofocus.roi[key],
		);
		const cameras = revisedSpec.resources.filter((resource) => resource.role === "frame_provider");
		const autofocusRoiSource =
			roiUnchanged && cameras.length === 1 && cameras[0]?.resourceId === proposal.autofocusRoiSource?.frameProviderResourceId
				? proposal.autofocusRoiSource
				: undefined;
		const revised = createProcedureProposal(ctx.cwd, revisedSpec, proposal.proposalId, autofocusRoiSource);
		supersedeProcedureProposal(ctx.cwd, proposal, revised.proposalId);
		const summary = `Proposal ${proposal.proposalId} superseded by ${revised.proposalId}. specHash=${revised.specHash}. Operator approval does not carry over; the new hash must be acknowledged.\n${describeAutofocusRoi(revisedSpec, autofocusRoiSource)}`;
		return {
			content: [{ type: "text", text: summary }],
			details: {
				status: "success",
				summary,
				proposalId: revised.proposalId,
				stateAfter: {
					proposalId: revised.proposalId,
					specHash: revised.specHash,
					revisionOf: proposal.proposalId,
					supersededProposalId: proposal.proposalId,
					previousSpecHash: proposal.specHash,
					requiresConfirmation: true,
					status: revised.status,
					procedureSpecId: revised.procedureSpecId,
					unitCount: preview.unitCount,
					estimatedRuntimeMs: preview.estimatedRuntimeMs,
					risks: preview.risks,
					limits: preview.limits,
					mappingAutofocus: preview.mappingAutofocus,
					autofocusRoi: { ...revisedSpec.domain.raman.autofocus.roi },
					autofocusRoiSource,
					reason: params.reason,
				},
			},
		};
	},
} satisfies ToolDefinition<typeof ReviseProposalParamsSchema, RuntimeToolDetails>;

export const approveAndStartRunTool = {
	name: "approve_and_start_run",
	label: "Approve And Start Run",
	description: "Approve a previously proposed ProcedureSpec, freeze it, and start the bounded run.",
	promptSnippet: "Approve a proposalId and start the frozen bounded run",
	promptGuidelines: [
		"Use this only after propose_run.",
		"Pass the proposalId together with the specHash that propose_run returned; never re-send the ProcedureSpec.",
		"To change any parameter, call revise_proposal instead of approving a stale proposal.",
	],
	parameters: ProposalIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProposalIdParams, _signal, _onUpdate, ctx) {
		const mode = params.executionMode ?? "simulation";
		if (mode === "live-supervised" && !getRamanLiveRuntime(ctx.cwd)) {
			return error("No live Raman runtime is registered for this workspace.", "live_runtime_unavailable", {
				executionMode: mode,
			});
		}

		try {
			const admitted = approveAndFreezeProcedureSpec({
				cwd: ctx.cwd,
				proposalId: params.proposalId,
				specHash: params.specHash,
				mode,
				admission: params.admission,
				operatorApproval: params.operatorApproval,
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
			return notActiveError(ctx.cwd, params.runId);
		}
	},
} satisfies ToolDefinition<typeof RunIdParamsSchema, RuntimeToolDetails>;

export const resumeRunTool = {
	name: "resume_run",
	label: "Resume Run",
	description: "Resume a paused bounded run from the unit where it paused, using its frozen ProcedureSpec.",
	promptSnippet: "Resume a paused bounded run from where it paused",
	promptGuidelines: [
		"For a paused run, always try resume_run first; never abort and re-propose just to continue.",
		"Resume replays the frozen spec from disk, so it cannot change any parameter; use revise_proposal plus a new run for that.",
		"Resume of a live-supervised run causes real hardware motion: report the resume unit and coordinates, then call again with confirmed=true after the operator agrees.",
	],
	parameters: ResumeRunParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ResumeRunParams, _signal, _onUpdate, ctx) {
		let plan: ReturnType<typeof planRunResume>;
		try {
			plan = planRunResume(ctx.cwd, params.runId);
		} catch (cause) {
			if (cause instanceof RunResumeError) {
				return error(cause.message, cause.code, cause.stateAfter);
			}
			throw cause;
		}

		const pointText = plan.point
			? ` at X=${plan.point.xUm}, Y=${plan.point.yUm}${plan.point.zUm === undefined ? "" : `, Z=${plan.point.zUm}`} um`
			: "";
		const target = `unit ${plan.startIndex} (${plan.unitId})${pointText}`;

		if (params.confirmed !== true) {
			const summary = `Run ${params.runId} is paused and would resume from ${target} of ${plan.units.length} units, ${plan.mode} mode. ${plan.runState.progress.completedUnits} units are already completed and will not be repeated. Call again with confirmed=true to resume.`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					status: "warning",
					summary,
					runId: params.runId,
					stateAfter: {
						...runSummaryState(plan.runState),
						resumePlan: {
							startIndex: plan.startIndex,
							unitId: plan.unitId,
							point: plan.point,
							totalUnits: plan.units.length,
							executionMode: plan.mode,
						},
					},
				},
			};
		}

		try {
			const runState = resumeRun(ctx.cwd, params.runId);
			return success(`Run ${params.runId} resumed from ${target}.`, runState);
		} catch (cause) {
			if (cause instanceof RunResumeError) {
				return error(cause.message, cause.code, cause.stateAfter);
			}
			return error(
				cause instanceof Error ? cause.message : String(cause),
				plan.mode === "live-supervised" ? "live_runtime_start_failed" : "simulation_start_failed",
			);
		}
	},
} satisfies ToolDefinition<typeof ResumeRunParamsSchema, RuntimeToolDetails>;

export const abortRunTool = {
	name: "abort_run",
	label: "Abort Run",
	description: "Request that an active bounded run abort at the next safe unit boundary.",
	promptSnippet: "Request an abort for a running bounded run",
	promptGuidelines: [
		"Abort takes effect at the next safe unit boundary, not in the middle of a unit.",
		"Abort discards the remaining units; to continue a paused run use resume_run instead.",
	],
	parameters: RunIdParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: RunIdParams, _signal, _onUpdate, ctx) {
		try {
			const runState = abortRun(ctx.cwd, params.runId);
			return success(`Abort requested for run ${params.runId}.`, runState);
		} catch {
			return notActiveError(ctx.cwd, params.runId);
		}
	},
} satisfies ToolDefinition<typeof RunIdParamsSchema, RuntimeToolDetails>;
