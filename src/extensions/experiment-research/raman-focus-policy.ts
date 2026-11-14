import type { ProcedureSpec } from "./schemas/procedure-spec.ts";

export const DEFAULT_MAPPING_SURFACE_CORRECTION = { kind: "disabled", reason: "default_disabled" } as const;

/** Make a new proposal's default explicit before computing its approval hash. */
export function withMappingFocusDefaults(spec: ProcedureSpec): ProcedureSpec {
	if (spec.procedureId === "raman_grid_mapping" &&
		(spec.plan.kind === "point_list" || spec.plan.kind === "grid_scan") &&
		spec.plan.surfaceCorrection === undefined) {
		return { ...spec, plan: { ...spec.plan, surfaceCorrection: { ...DEFAULT_MAPPING_SURFACE_CORRECTION } } };
	}
	return spec;
}

/** Local mapping without a plane starts from the measured run-start Z. */
export function usesInitialPositionFocus(spec: ProcedureSpec): boolean {
	return spec.procedureId === "raman_grid_mapping" &&
		spec.domain.raman.autofocus.params?.strategy !== "fixed_absolute" &&
		(spec.plan.kind === "point_list" || spec.plan.kind === "grid_scan") &&
		spec.plan.surfaceCorrection?.kind !== "focus_plane";
}
