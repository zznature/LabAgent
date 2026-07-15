import type { ProcedureSpec } from "../schemas/index.ts";
import { summarizeProcedureProposal, type ProposalRisk } from "../planner/procedure-spec-builder.ts";
import { validateRuntimeAnchorState, type RamanLiveRuntime, type RamanLivePreflightResult } from "../runtime/raman/index.ts";
import { validateExecutionContract, type ExecutionContractIssue } from "./validate-execution.ts";

export interface LiveRunPreparation {
	contractIssues: ExecutionContractIssue[];
	forbiddenRisks: ProposalRisk[];
	livePreflight: RamanLivePreflightResult;
	anchorValidation: { valid: boolean; details: Record<string, unknown> };
	ready: boolean;
}

function resourceBindingIssues(spec: ProcedureSpec, runtime: RamanLiveRuntime): ExecutionContractIssue[] {
	const expected = new Map([
		["stage", runtime.stage.resource.resourceId],
		["frame_provider", runtime.frame.resource.resourceId],
		["spectrometer", runtime.spectrometer.resource.resourceId],
	]);
	const issues: ExecutionContractIssue[] = [];
	for (const [role, resourceId] of expected) {
		const requested = spec.resources.find((resource) => resource.role === role)?.resourceId;
		if (requested !== undefined && requested !== resourceId) {
			issues.push({
				level: "forbidden",
				code: "resource_binding_mismatch",
				message: `Resource role ${role} references ${requested}, but the live runtime provides ${resourceId}.`,
			});
		}
	}
	return issues;
}

export async function prepareLiveRun(spec: ProcedureSpec, runtime: RamanLiveRuntime): Promise<LiveRunPreparation> {
	const contractIssues = [
		...validateExecutionContract(spec, "live-supervised"),
		...resourceBindingIssues(spec, runtime),
	];
	const forbiddenRisks = summarizeProcedureProposal(spec).risks.filter((risk) => risk.level === "forbidden");
	const livePreflight = await runtime.preflight();
	const anchorValidation = livePreflight.preflightReady && livePreflight.controlAvailable
		? await validateRuntimeAnchorState(spec, runtime)
		: { valid: false, details: { skipped: true, reason: "runtime_preflight_not_ready" } };
	return {
		contractIssues,
		forbiddenRisks,
		livePreflight,
		anchorValidation,
		ready:
			contractIssues.length === 0 &&
			forbiddenRisks.length === 0 &&
			livePreflight.preflightReady &&
			livePreflight.controlAvailable &&
			anchorValidation.valid,
	};
}
