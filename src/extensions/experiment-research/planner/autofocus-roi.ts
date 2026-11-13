import type { ProcedureSpec } from "../schemas/index.ts";
import { listExperimentProcedureTemplates } from "../store/experiment-template-store.ts";
import type { AutofocusRoiSource } from "../store/proposal-store.ts";

interface RoiTemplateApplication {
	templateId: string;
	templateVersion: string;
	inheritedFields: string[];
	overriddenFields?: string[];
}

/** Resolve explicitly inherited ROI before proposal hashing; never consult run history. */
export function resolveAutofocusRoiTemplate(
	cwd: string | undefined,
	spec: ProcedureSpec,
	application?: RoiTemplateApplication,
): { spec: ProcedureSpec; source?: AutofocusRoiSource } {
	const roiPath = "domain.raman.autofocus.roi";
	if (!application || !application.inheritedFields.some((path) => roiPath === path || roiPath.startsWith(`${path}.`))) {
		return { spec };
	}
	if (application.overriddenFields?.some(
		(path) => roiPath === path || roiPath.startsWith(`${path}.`) || path.startsWith(`${roiPath}.`),
	)) {
		return { spec };
	}
	if (!cwd) {
		throw new Error("A workspace is required to inherit an autofocus ROI template.");
	}
	const template = listExperimentProcedureTemplates(cwd).templates.find(
		(candidate) => candidate.templateId === application.templateId,
	);
	if (!template || template.templateVersion !== application.templateVersion || template.procedureId !== spec.procedureId) {
		throw new Error(`Cannot inherit ROI from ${application.templateId}@${application.templateVersion}: a valid matching workspace template is required.`);
	}
	const roi = template.defaults.domain?.raman.autofocus.roi;
	if (!roi) {
		throw new Error(`Template ${template.templateId} does not define an autofocus ROI.`);
	}
	const templateCameras = template.defaults.resources?.filter((resource) => resource.role === "frame_provider") ?? [];
	const cameras = spec.resources.filter((resource) => resource.role === "frame_provider");
	const camera = cameras[0];
	if (templateCameras.length !== 1 || cameras.length !== 1 || !camera || templateCameras[0]?.resourceId !== camera.resourceId) {
		throw new Error(`Cannot inherit ROI from ${template.templateId}: template and proposal must identify the same single frame_provider resource.`);
	}
	return {
		spec: {
			...spec,
			domain: {
				...spec.domain,
				raman: {
					...spec.domain.raman,
					autofocus: { ...spec.domain.raman.autofocus, roi: { ...roi } },
				},
			},
		},
		source: { templateId: template.templateId, templateVersion: template.templateVersion, frameProviderResourceId: camera.resourceId },
	};
}

export function describeAutofocusRoi(spec: ProcedureSpec, source?: AutofocusRoiSource): string {
	const { enabled, roi } = spec.domain.raman.autofocus;
	const origin = source
		? `workspace template ${source.templateId}@${source.templateVersion}, frame provider ${source.frameProviderResourceId}`
		: "explicit ProcedureSpec";
	return `Autofocus ${enabled ? "enabled" : "disabled"}. ROI (pixels, top-left origin): x=${roi.x}, y=${roi.y}, width=${roi.width}, height=${roi.height}. Source: ${origin}.`;
}
