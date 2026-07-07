import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExperimentIntent, ProcedureId, ProcedureSpec } from "../schemas/index.ts";
import { ExperimentIntentValidator, ProcedureSpecValidator, formatValidationErrors } from "../schemas/index.ts";
import { summarizeProcedureProposal } from "../planner/procedure-spec-builder.ts";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import { getRamanLiveRuntime, getRamanPythonRuntimeConfigInfo, validateRuntimeAnchorState } from "../runtime/raman/index.ts";
import { saveExperimentIntent } from "../store/index.ts";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

const ExecutionModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("live-supervised"),
]);

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

const ProcedureSpecParamsSchema = Type.Object(
	{
		spec: ProcedureSpecInputSchema,
		executionMode: Type.Optional(ExecutionModeSchema),
	},
	{ additionalProperties: false },
);

const ProcedureSpecTemplateParamsSchema = Type.Object(
	{
		procedureId: Type.Union([
			Type.Literal("raman_single_point_probe"),
			Type.Literal("raman_parameter_search"),
			Type.Literal("raman_grid_mapping"),
		]),
	},
	{ additionalProperties: false },
);

const ExperimentIntentInputSchema = Type.Object(
	{
		intentId: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		objective: Type.String({ minLength: 1 }),
		hypothesis: Type.Optional(Type.String({ minLength: 1 })),
		question: Type.Optional(Type.String({ minLength: 1 })),
		constraints: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		successCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		notes: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const ExperimentIntentParamsSchema = Type.Object(
	{
		intent: ExperimentIntentInputSchema,
	},
	{ additionalProperties: false },
);

interface PlannerToolDetails {
	status: "success" | "warning" | "error";
	summary: string;
	errorCode?: string;
	retrySafe?: boolean;
	stateAfter: Record<string, unknown>;
}

type ProcedureSpecParams = Static<typeof ProcedureSpecParamsSchema>;
type ProcedureSpecTemplateParams = Static<typeof ProcedureSpecTemplateParamsSchema>;
type ExperimentIntentParams = Static<typeof ExperimentIntentParamsSchema>;
type ExecutionMode = Static<typeof ExecutionModeSchema>;

function success(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: PlannerToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "success",
			summary,
			stateAfter,
		},
	};
}

function warning(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: PlannerToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "warning",
			summary,
			stateAfter,
		},
	};
}

function error(summary: string, errorCode: string, stateAfter: Record<string, unknown> = {}): { content: [{ type: "text"; text: string }]; details: PlannerToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "error",
			summary,
			errorCode,
			retrySafe: true,
			stateAfter,
		},
	};
}

function asProcedureSpec(params: ProcedureSpecParams): ProcedureSpec {
	return params.spec as ProcedureSpec;
}

function validateProcedureSpec(spec: ProcedureSpec): { valid: boolean; issues: string[] } {
	if (!ProcedureSpecValidator.Check(spec)) {
		return {
			valid: false,
			issues: formatValidationErrors(ProcedureSpecValidator, spec),
		};
	}
	return { valid: true, issues: [] };
}

function previewState(spec: ProcedureSpec): Record<string, unknown> {
	const units = compileProcedureSpec(spec);
	const preview = summarizeProcedureProposal(spec);
	return {
		valid: true,
		procedureId: spec.procedureId,
		procedureSpecId: spec.procedureSpecId,
		unitCount: units.length,
		estimatedRuntimeMs: preview.estimatedRuntimeMs,
		estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
		savePath: preview.savePath,
		requiresConfirmation: preview.requiresConfirmation,
		risks: preview.risks,
		limits: preview.limits,
	};
}

function hasRequiredRamanRoles(spec: ProcedureSpec): boolean {
	const roles = new Set(spec.resources.map((resource) => resource.role));
	return roles.has("stage") && roles.has("frame_provider") && roles.has("spectrometer");
}

function resolveExecutionMode(params: ProcedureSpecParams): ExecutionMode {
	return params.executionMode ?? "simulation";
}

function templateForProcedure(procedureId: ProcedureId): Record<string, unknown> {
	const common = {
		procedureSpecId: "replace-with-stable-procedure-spec-id",
		experimentId: "replace-with-experiment-id",
		intentId: "replace-with-recorded-intent-id",
		procedureId,
		procedureVersion: "0.1.0",
		resources: [
			{ resourceId: "stage-main", role: "stage" },
			{ resourceId: "frame-main", role: "frame_provider" },
			{ resourceId: "spectrometer-main", role: "spectrometer" },
		],
		limits: {
			maxLaserPowerPercent: 25,
			minObjectiveClearanceUm: 200,
			xRangeUm: { minUm: 0, maxUm: 50_000 },
			yRangeUm: { minUm: 0, maxUm: 50_000 },
			zRangeUm: { minUm: 200, maxUm: 5_000 },
		},
		stoppingRules: {
			maxRuntimeMinutes: 180,
			maxUnits: 1,
			stopOnError: true,
			maxConsecutiveFailures: 1,
		},
		domain: {
			raman: {
				autofocus: {
					enabled: true,
					roi: { x: 492, y: 353, width: 225, height: 225 },
					params: {
						zStartUm: 1450,
						zEndUm: 1550,
						targetSpacingUm: 5,
						minPoints: 5,
						maxPoints: 25,
						framesPerZ: 1,
						finalVerificationFramesPerZ: 1,
					},
				},
				acquisition: {
					integrationTimeMs: 180_000,
					laserPowerPercent: 25,
					accumulations: 1,
					saveFormat: "txt",
					timeoutMs: 240_000,
				},
			},
		},
	};

	if (procedureId === "raman_single_point_probe") {
		return {
			...common,
			plan: {
				kind: "current_position",
				perPoint: [
					{ kind: "move_to_point" },
					{ kind: "autofocus" },
					{ kind: "capture_frame" },
					{ kind: "acquire_spectrum" },
				],
			},
		};
	}

	if (procedureId === "raman_parameter_search") {
		return {
			...common,
			stoppingRules: {
				maxRuntimeMinutes: 60,
				maxUnits: 3,
				stopOnError: true,
				maxConsecutiveFailures: 1,
			},
			plan: {
				kind: "point_list",
				points: [
					{ xUm: 1_000, yUm: 2_000, zUm: 1_500 },
					{ xUm: 1_000, yUm: 2_000, zUm: 1_500 },
					{ xUm: 1_000, yUm: 2_000, zUm: 1_500 },
				],
				perPoint: [
					{ kind: "move_to_point" },
					{ kind: "autofocus" },
					{ kind: "capture_frame" },
					{ kind: "acquire_spectrum" },
				],
			},
			domain: {
				raman: {
					...(common.domain.raman),
					parameterSearch: {
						maxAttempts: 3,
						laserPowerPercentValues: [1, 5, 10],
						integrationTimeMs: { min: 1_000, max: 10_000 },
						accumulations: [1, 2],
					},
				},
			},
		};
	}

	return {
		...common,
		stoppingRules: {
			maxRuntimeMinutes: 180,
			maxUnits: 20,
			stopOnError: false,
			maxConsecutiveFailures: 20,
		},
		plan: {
			kind: "point_list",
			points: [
				{ xUm: 2_375, yUm: 1_640, zUm: 1_510 },
				{ xUm: 2_475, yUm: 1_640, zUm: 1_510 },
				{ xUm: 2_575, yUm: 1_640, zUm: 1_510 },
			],
			perPoint: [
				{ kind: "move_to_point" },
				{ kind: "autofocus" },
				{ kind: "capture_frame" },
				{ kind: "acquire_spectrum" },
			],
		},
	};
}

async function buildPreflightState(
	spec: ProcedureSpec,
	cwd: string,
	executionMode: ExecutionMode,
): Promise<Record<string, unknown>> {
	const preview = summarizeProcedureProposal(spec);
	const forbiddenRisks = preview.risks.filter((risk) => risk.level === "forbidden");
	const requiredRolesPresent = hasRequiredRamanRoles(spec);
	const requestedModeSupported = executionMode === "simulation" || requiredRolesPresent;

	if (executionMode === "simulation") {
		return {
			mode: executionMode,
			procedureSpecId: spec.procedureSpecId,
			procedureId: spec.procedureId,
			unitCount: preview.unitCount,
			estimatedRuntimeMs: preview.estimatedRuntimeMs,
			estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
			readyForApproval: forbiddenRisks.length === 0 && requiredRolesPresent,
			preflightReady: true,
			controlAvailable: true,
			requiresConfirmation: preview.requiresConfirmation,
			risks: preview.risks,
			limits: preview.limits,
			savePath: preview.savePath,
			requiredRolesPresent,
			requestedModeSupported,
			canProposeRun: true,
		};
	}

	const runtime = getRamanLiveRuntime(cwd);
	if (!runtime) {
		return {
			mode: executionMode,
			procedureSpecId: spec.procedureSpecId,
			procedureId: spec.procedureId,
			unitCount: preview.unitCount,
			estimatedRuntimeMs: preview.estimatedRuntimeMs,
			estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
			readyForApproval: false,
			preflightReady: false,
			controlAvailable: false,
			requiresConfirmation: preview.requiresConfirmation,
			risks: preview.risks,
			limits: preview.limits,
			savePath: preview.savePath,
			requiredRolesPresent,
			requestedModeSupported,
			realRuntimeRegistered: false,
			canProposeRun: true,
		};
	}

	const livePreflight = await runtime.preflight();
	const anchorValidation = livePreflight.preflightReady && livePreflight.controlAvailable
		? await validateRuntimeAnchorState(spec, runtime)
		: { valid: false, details: { skipped: true, reason: "runtime_preflight_not_ready" } };
	return {
		mode: executionMode,
		procedureSpecId: spec.procedureSpecId,
		procedureId: spec.procedureId,
		unitCount: preview.unitCount,
		estimatedRuntimeMs: preview.estimatedRuntimeMs,
		estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
		readyForApproval:
			forbiddenRisks.length === 0 &&
			requiredRolesPresent &&
			requestedModeSupported &&
			livePreflight.preflightReady &&
			livePreflight.controlAvailable &&
			anchorValidation.valid,
		preflightReady: livePreflight.preflightReady,
		controlAvailable: livePreflight.controlAvailable,
		requiresConfirmation: preview.requiresConfirmation,
		risks: preview.risks,
		limits: preview.limits,
		savePath: preview.savePath,
		requiredRolesPresent,
		requestedModeSupported,
		realRuntimeRegistered: true,
		livePreflightDetails: livePreflight.details ?? {},
		stageAnchorValid: anchorValidation.valid,
		stageAnchorDetails: anchorValidation.details,
		canProposeRun: true,
	};
}

export const getLabCapabilitiesTool = {
	name: "get_lab_capabilities",
	label: "Get Lab Capabilities",
	description: "Return the currently scaffolded LabAgents MVP rebuild capability surface.",
	promptSnippet: "Inspect the currently available high-level lab capability surface",
	promptGuidelines: [
		"Use this before planning or validating a bounded run when you need to know which capability classes are already wired in the rebuild.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute() {
		return success("LabAgents MVP rebuild planner capabilities loaded.", {
			source: "experiment-research",
			stage: "phase10-bounded-search-and-mapping",
			supportedProcedures: [
				"raman_single_point_probe",
				"raman_parameter_search",
				"raman_grid_mapping",
			],
			liveSupportedProceduresWhenRuntimeRegistered: [
				"raman_single_point_probe",
				"raman_parameter_search",
				"raman_grid_mapping",
			],
			plannerTools: [
				"get_lab_capabilities",
				"get_lab_state",
				"record_experiment_intent",
				"get_procedure_spec_template",
				"validate_procedure_spec",
				"run_preflight",
				"propose_run",
				"approve_and_start_run",
			],
			evaluation: {
				ruleBasedGoodEnoughDecisions: true,
				decisionKinds: [
					"acceptable",
					"continue_search_within_envelope",
					"stop_and_request_user_decision",
				],
			},
			runtimeContract: {
				ramanResourcesDefined: true,
				ramanActionsDefined: true,
				actionResultContractDefined: true,
				liveRuntimeRequiresRegistration: true,
				liveSinglePointExecutionRequiresRegisteredRuntime: true,
				liveParameterSearchExecutionRequiresRegisteredRuntime: true,
				liveGridMappingExecutionRequiresRegisteredRuntime: true,
			},
		});
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, PlannerToolDetails>;

export const recordExperimentIntentTool = {
	name: "record_experiment_intent",
	label: "Record Experiment Intent",
	description: "Persist the structured research intent before deriving bounded ProcedureSpecs.",
	promptSnippet: "Record the user's structured ExperimentIntent before creating a bounded ProcedureSpec",
	promptGuidelines: [
		"Use this for non-trivial experiment requests before drafting a ProcedureSpec.",
		"Store assumptions and constraints in the intent so the ProcedureSpec can reference intentId without carrying research memory.",
	],
	parameters: ExperimentIntentParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ExperimentIntentParams, _signal, _onUpdate, ctx) {
		const intent = params.intent as ExperimentIntent;
		if (!ExperimentIntentValidator.Check(intent)) {
			return error("ExperimentIntent validation failed.", "invalid_experiment_intent", {
				valid: false,
				issues: formatValidationErrors(ExperimentIntentValidator, intent),
			});
		}
		try {
			const stored = saveExperimentIntent(ctx.cwd, intent);
			return success(`ExperimentIntent ${intent.intentId} recorded for experiment ${intent.experimentId}.`, {
				intentId: intent.intentId,
				experimentId: intent.experimentId,
				path: stored.path,
				objective: intent.objective,
				constraints: intent.constraints ?? {},
				successCriteria: intent.successCriteria ?? [],
			});
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return error(message, "experiment_intent_store_failed", {
				intentId: intent.intentId,
				experimentId: intent.experimentId,
			});
		}
	},
} satisfies ToolDefinition<typeof ExperimentIntentParamsSchema, PlannerToolDetails>;

export const getProcedureSpecTemplateTool = {
	name: "get_procedure_spec_template",
	label: "Get Procedure Spec Template",
	description: "Return the canonical minimal ProcedureSpec shape for a supported Raman procedure.",
	promptSnippet: "Fetch the canonical ProcedureSpec template before drafting a bounded Raman run",
	promptGuidelines: [
		"Use this before manually drafting a ProcedureSpec for a Raman run.",
		"Do not invent additional ProcedureSpec fields; adapt the returned template and then call validate_procedure_spec.",
	],
	parameters: ProcedureSpecTemplateParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProcedureSpecTemplateParams) {
		return success(`Canonical ProcedureSpec template loaded for ${params.procedureId}.`, {
			procedureId: params.procedureId,
			schemaVersion: "0.1.0",
			template: templateForProcedure(params.procedureId),
			notes: [
				"ProcedureSpec supports plan.kind values current_position, point_list, and grid_scan.",
				"Line scans should use point_list when one axis is fixed and pitchYUm would be zero.",
				"Use limits only for maxLaserPowerPercent, minObjectiveClearanceUm, xRangeUm, yRangeUm, and zRangeUm.",
				"Store the research goal with record_experiment_intent, then reference its intentId here.",
			],
		});
	},
} satisfies ToolDefinition<typeof ProcedureSpecTemplateParamsSchema, PlannerToolDetails>;

export const getLabStateTool = {
	name: "get_lab_state",
	label: "Get Lab State",
	description: "Return the current MVP rebuild extension state and planning mode.",
	promptSnippet: "Inspect the current rebuild-mode lab state before planning the next step",
	promptGuidelines: [
		"Use this before validating or proposing a bounded run so the user can see the current planning and execution boundary.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtimeConfig = getRamanPythonRuntimeConfigInfo(ctx.cwd);
		const liveRuntimeRegistered = getRamanLiveRuntime(ctx.cwd) !== undefined;
		return success("LabAgents planner proposal flow is active.", {
			source: "experiment-research",
			stage: "phase10-bounded-search-and-mapping",
			canValidateProcedureSpecs: true,
			canRunPreflight: true,
			canExecuteSimulationRuns: true,
			canExecuteLiveSinglePointRuns: liveRuntimeRegistered,
			canExecuteLiveParameterSearchRuns: liveRuntimeRegistered,
			canExecuteLiveGridMappingRuns: liveRuntimeRegistered,
			runtimeConfig: {
				source: runtimeConfig.source,
				path: runtimeConfig.path,
				enabled: runtimeConfig.enabled,
			},
			configuredResources: runtimeConfig.resources,
			requiresApproval: true,
			executionEntryPoint: "validate_procedure_spec -> run_preflight -> propose_run -> approve_and_start_run",
			goodEnoughDecisionMode: "explicit_rules",
			ramanRuntimeContractDefined: true,
			nextMilestone: "verification and operator-facing refinement",
		});
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, PlannerToolDetails>;

export const validateProcedureSpecTool = {
	name: "validate_procedure_spec",
	label: "Validate Procedure Spec",
	description: "Validate a bounded ProcedureSpec draft and summarize its proposed run envelope.",
	promptSnippet: "Validate a bounded ProcedureSpec draft before preflight or approval",
	promptGuidelines: [
		"Use validate_procedure_spec before run_preflight or propose_run.",
		"Treat validation success as a bounded planning result, not execution approval.",
	],
	parameters: ProcedureSpecParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProcedureSpecParams) {
		const spec = asProcedureSpec(params);
		const validation = validateProcedureSpec(spec);
		if (!validation.valid) {
			return error("ProcedureSpec validation failed.", "invalid_procedure_spec", {
				valid: false,
				issues: validation.issues,
			});
		}

		return success("ProcedureSpec is valid for bounded planner proposal flow.", previewState(spec));
	},
} satisfies ToolDefinition<typeof ProcedureSpecParamsSchema, PlannerToolDetails>;

export const runPreflightTool = {
	name: "run_preflight",
	label: "Run Preflight",
	description: "Check bounded run readiness before proposal approval.",
	promptSnippet: "Run planner-side preflight checks before proposing an executable bounded run",
	promptGuidelines: [
		"Use run_preflight after validate_procedure_spec and before propose_run.",
		"Do not treat preflight as execution approval; it only checks the current bounded proposal surface.",
	],
	parameters: ProcedureSpecParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProcedureSpecParams, _signal, _onUpdate, ctx) {
		const spec = asProcedureSpec(params);
		const validation = validateProcedureSpec(spec);
		if (!validation.valid) {
			return error("ProcedureSpec preflight failed because the spec is invalid.", "invalid_procedure_spec", {
				valid: false,
				issues: validation.issues,
			});
		}

		const state = await buildPreflightState(spec, ctx.cwd, resolveExecutionMode(params));
		if (state.requiredRolesPresent !== true) {
			return error("ProcedureSpec preflight failed because required Raman resources are missing.", "preflight_missing_resources", state);
		}

		if (state.requestedModeSupported !== true) {
			return warning("Requested execution mode is not supported for this ProcedureSpec in the current MVP phase.", state);
		}

		if ((state.risks as Array<{ level: string }>).some((risk) => risk.level === "forbidden")) {
			return warning("ProcedureSpec preflight found forbidden risks that must be resolved before approval.", state);
		}

		if (state.preflightReady !== true || state.controlAvailable !== true) {
			return warning("ProcedureSpec preflight is waiting on live runtime readiness or control availability.", state);
		}

		if (state.stageAnchorValid === false) {
			return warning("ProcedureSpec preflight found current stage position inconsistent with the approved autofocus envelope.", state);
		}

		return success("ProcedureSpec preflight is ready for supervised proposal approval.", state);
	},
} satisfies ToolDefinition<typeof ProcedureSpecParamsSchema, PlannerToolDetails>;
