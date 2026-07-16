import type { ProcedureSpec } from "../schemas/index.ts";
import { compileProcedureSpec } from "./compile-units.ts";
import type { ExecutionMode } from "./run-admission.ts";

export interface ExecutionContractIssue {
	level: "forbidden";
	code: string;
	message: string;
}

export function validateExecutionContract(spec: ProcedureSpec, mode: ExecutionMode): ExecutionContractIssue[] {
	if (mode !== "live-supervised") {
		return [];
	}

	const issues: ExecutionContractIssue[] = [];
	const roles = new Set(spec.resources.map((resource) => resource.role));
	for (const role of ["stage", "frame_provider", "spectrometer"] as const) {
		if (!roles.has(role)) {
			issues.push({
				level: "forbidden",
				code: `missing_${role}_resource`,
				message: `Live Raman execution requires a ${role} resource binding.`,
			});
		}
	}

	const units = compileProcedureSpec(spec);
	for (const unit of units) {
		if (unit.positionRef !== "current" && unit.point?.zUm === undefined) {
			issues.push({
				level: "forbidden",
				code: "missing_z_coordinate",
				message: `Compiled unit ${unit.index} requires zUm for live Raman motion.`,
			});
			break;
		}
	}

	const actionKinds = new Set(units.flatMap((unit) => unit.actions.map((action) => action.kind)));
	if (!actionKinds.has("autofocus") || !actionKinds.has("acquire_spectrum")) {
		issues.push({
			level: "forbidden",
			code: "incomplete_raman_action_sequence",
			message: "Live Raman execution requires autofocus and acquire_spectrum actions.",
		});
	}
	for (const unit of units) {
		const autofocusIndexes = unit.actions.flatMap((action, index) => action.kind === "autofocus" ? [index] : []);
		const spectrumCount = unit.actions.filter((action) => action.kind === "acquire_spectrum").length;
		if (autofocusIndexes.length !== 1 || spectrumCount !== 1) {
			issues.push({
				level: "forbidden",
				code: "ambiguous_raman_action_sequence",
				message: `Compiled unit ${unit.index} requires exactly one autofocus and one acquire_spectrum action.`,
			});
			continue;
		}
		const autofocusIndex = autofocusIndexes[0]!;
		const invalidFocusEvidence = unit.actions.some((action, index) =>
			action.kind === "capture_frame" && (
				(action.role === "pre_focus" && index > autofocusIndex) ||
				(action.role === "post_focus" && index < autofocusIndex)
			),
		);
		if (invalidFocusEvidence) {
			issues.push({
				level: "forbidden",
				code: "invalid_focus_evidence_order",
				message: `Compiled unit ${unit.index} requires pre_focus captures before autofocus and post_focus captures after autofocus.`,
			});
		}
	}
	const autofocusParams = spec.domain.raman.autofocus.params;
	if (actionKinds.has("autofocus") && (typeof autofocusParams?.zStartUm !== "number" || typeof autofocusParams.zEndUm !== "number")) {
		issues.push({
			level: "forbidden",
			code: "autofocus_invalid_params",
			message: "Live fixed-range autofocus requires numeric zStartUm and zEndUm.",
		});
	}

	return issues;
}
