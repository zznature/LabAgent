import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProcedureSpec, RunState } from "../schemas/index.ts";
import { ProcedureSpecValidator, formatValidationErrors } from "../schemas/index.ts";
import {
	abortRun,
	pauseRun,
	pollRun,
	startLiveRamanRun,
	startSimulationRun,
} from "../kernel/run-controller.ts";
import { getRamanLiveRuntime } from "../runtime/raman/index.ts";
import {
	approveProcedureProposal,
	createProcedureProposal,
	findProcedureProposal,
	hashProcedureSpec,
} from "../store/index.ts";

const ProcedureSpecInputSchema = Type.Object(
	{
		procedureSpecId: Type.String(),
		experimentId: Type.String(),
		intentId: Type.String(),
		procedureId: Type.Union([
			Type.Literal("raman_single_point_probe"),
			Type.Literal("raman_parameter_search"),
			Type.Literal("raman_grid_mapping"),
		]),
		procedureVersion: Type.String(),
		resources: Type.Array(
			Type.Object(
				{
					resourceId: Type.String(),
					role: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		limits: Type.Record(Type.String(), Type.Unknown()),
		plan: Type.Record(Type.String(), Type.Unknown()),
		stoppingRules: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		domain: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: true },
);

const SimulationControlsSchema = Type.Object(
	{
		perUnitDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
		autofocusLowConfidenceAtUnit: Type.Optional(Type.Integer({ minimum: 0 })),
		autofocusLowConfidenceAtUnits: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		spectrumTimeoutAtUnit: Type.Optional(Type.Integer({ minimum: 0 })),
		spectrumTimeoutAtUnits: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
		operatorPauseAtUnit: Type.Optional(Type.Integer({ minimum: 0 })),
		parameterSearchObservations: Type.Optional(
			Type.Array(
				Type.Object(
					{
						autofocusConfidence: Type.Number({ minimum: 0, maximum: 1 }),
						saturated: Type.Boolean(),
						snr: Type.Number({ minimum: 0 }),
						targetPeakBaselineRatio: Type.Number({ minimum: 0 }),
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);

const ExecutionModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("live-supervised"),
]);

const AdmissionSchema = Type.Object(
	{
		preflightReady: Type.Boolean(),
		controlAvailable: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const RunProcedureParamsSchema = Type.Object(
	{
		spec: ProcedureSpecInputSchema,
		simulation: Type.Optional(SimulationControlsSchema),
		executionMode: Type.Optional(ExecutionModeSchema),
		admission: Type.Optional(AdmissionSchema),
	},
	{ additionalProperties: false },
);

const RunIdParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

type RunProcedureParams = Static<typeof RunProcedureParamsSchema>;
type RunIdParams = Static<typeof RunIdParamsSchema>;

const ProposalIdParamsSchema = Type.Object(
	{
		proposalId: Type.String({ minLength: 1 }),
		spec: ProcedureSpecInputSchema,
		simulation: Type.Optional(SimulationControlsSchema),
		executionMode: Type.Optional(ExecutionModeSchema),
		admission: Type.Optional(AdmissionSchema),
	},
	{ additionalProperties: false },
);

type ProposalIdParams = Static<typeof ProposalIdParamsSchema>;
type ExecutionMode = Static<typeof ExecutionModeSchema>;

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

function missingAdmissionError(
	mode: ExecutionMode,
	admission: ProposalIdParams["admission"],
): { content: [{ type: "text"; text: string }]; details: RuntimeToolDetails } | undefined {
	if (mode !== "live-supervised") {
		return undefined;
	}

	if (!admission?.preflightReady) {
		return error("Live supervised execution requires preflightReady=true before approval and start.", "preflight_not_ready", {
			executionMode: mode,
			admission,
		});
	}

	if (!admission.controlAvailable) {
		return error("Live supervised execution requires controlAvailable=true before approval and start.", "control_not_available", {
			executionMode: mode,
			admission,
		});
	}

	return undefined;
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
		const proposal = createProcedureProposal(ctx.cwd, params.spec as ProcedureSpec);
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
		const proposal = findProcedureProposal(ctx.cwd, params.proposalId);
		if (!proposal) {
			return error(`Proposal ${params.proposalId} was not found.`, "proposal_not_found");
		}
		if (proposal.status !== "proposed") {
			return error(`Proposal ${params.proposalId} is already approved.`, "proposal_not_pending");
		}
		const requestedHash = hashProcedureSpec(params.spec as ProcedureSpec);
		if (requestedHash !== proposal.specHash) {
			return error(
				`Proposal ${params.proposalId} no longer matches the provided ProcedureSpec. Approval rejected.`,
				"proposal_spec_mismatch",
			);
		}

		const mode = resolveExecutionMode(params);
		const admissionError = missingAdmissionError(mode, params.admission);
		if (admissionError) {
			return admissionError;
		}

		if (mode === "live-supervised" && !getRamanLiveRuntime(ctx.cwd)) {
			return error("No live Raman runtime is registered for this workspace.", "live_runtime_unavailable", {
				executionMode: mode,
			});
		}

		const approvedProposal = approveProcedureProposal(ctx.cwd, proposal);
		try {
			const runState =
				mode === "live-supervised"
					? startLiveRamanRun(ctx.cwd, proposal.spec, approvedProposal)
					: startSimulationRun(ctx.cwd, proposal.spec, params.simulation, approvedProposal);
			const modeLabel = mode === "live-supervised" ? "live supervised" : "simulation";
			return success(`${modeLabel} run ${runState.runId} started from approved proposal ${proposal.proposalId}.`, runState);
		} catch (cause) {
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
