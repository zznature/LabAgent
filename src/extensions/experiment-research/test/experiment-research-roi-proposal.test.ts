import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcedureSpec } from "../schemas/index.ts";
import { findProcedureProposal, hashProcedureSpec } from "../store/proposal-store.ts";
import { findExperimentProcedureTemplateTool, getProcedureSpecTemplateTool, runPreflightTool, validateProcedureSpecTool } from "../tools/planner.ts";
import { proposeRunTool, reviseProposalTool } from "../tools/runtime.ts";

const roots: string[] = [];
const reviewedRoi = { x: 491, y: 352, width: 225, height: 225 };
const selection = { templateId: "camera-grid", templateVersion: "1", inheritedFields: ["domain"], overriddenFields: [] };

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "raman-roi-proposal-"));
	roots.push(cwd);
	const context = { cwd } as ExtensionContext;
	const spec: ProcedureSpec = {
		procedureSpecId: "roi-grid", experimentId: "roi-test", intentId: "roi-intent", procedureVersion: "1", procedureId: "raman_grid_mapping",
		resources: [{ resourceId: "stage", role: "stage" }, { resourceId: "camera", role: "frame_provider" }, { resourceId: "spectrometer", role: "spectrometer" }],
		limits: { zRangeUm: { minUm: 1800, maxUm: 2600 } },
		plan: {
			kind: "grid_scan", grid: { origin: { xUm: 0, yUm: 0, zUm: 2300 }, rows: 2, cols: 2, pitchXUm: 10, pitchYUm: 10, order: "snake" },
			surfaceCorrection: { kind: "disabled", reason: "user_declined" },
			perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
		},
		domain: { raman: {
			autofocus: { enabled: true, roi: { x: 1208, y: 930, width: 225, height: 225 } },
			acquisition: { integrationTimeMs: 180000, accumulations: 1, laserPowerPercent: 3.2, timeoutMs: 300000 },
		} },
	};
	const template = {
		templateId: "camera-grid", templateVersion: "1", procedureId: "raman_grid_mapping", label: "Reviewed camera ROI",
		match: { defaultForProcedure: true },
		defaults: { resources: spec.resources, domain: { raman: { ...spec.domain.raman, autofocus: { enabled: true, roi: reviewedRoi } } } },
	};
	mkdirSync(join(cwd, "lab-config/templates"), { recursive: true });
	const path = join(cwd, "lab-config/templates/camera-grid.json");
	writeFileSync(path, JSON.stringify(template));
	return { cwd, context, spec, template, path };
}

describe("ROI review and reuse in proposals", () => {
	it("returns reusable coordinates and template identity in model-visible tool content", async () => {
		const { context } = setup();
		const found = await findExperimentProcedureTemplateTool.execute("find", { procedureId: "raman_grid_mapping" }, undefined, undefined, context);
		expect(found.content[0].text).toContain('"x": 491');
		expect(found.content[0].text).toContain('"templateApplication"');
		const canonical = await getProcedureSpecTemplateTool.execute("canonical", { procedureId: "raman_grid_mapping" });
		expect(canonical.content[0].text).toContain('"roi"');
	});

	it("uses the selected camera template consistently through validation, preflight, and persisted proposal", async () => {
		const { cwd, context, spec } = setup();
		for (const tool of [validateProcedureSpecTool, runPreflightTool, proposeRunTool]) {
			const result = await tool.execute("roi", { spec, templateApplication: selection }, undefined, undefined, context);
			expect(result.details.status, result.content[0].text).toBe("success");
			expect(result.content[0].text).toContain("x=491, y=352, width=225, height=225");
			expect(result.content[0].text).toContain("camera-grid@1");
			expect(result.details.stateAfter.autofocusRoi).toEqual(reviewedRoi);
			if (tool === proposeRunTool) {
				const stored = findProcedureProposal(cwd, String(result.details.stateAfter.proposalId));
				expect(stored?.spec.domain.raman.autofocus.roi).toEqual(reviewedRoi);
				expect(stored?.specHash).toBe(hashProcedureSpec(stored!.spec));
			}
		}
		expect(spec.domain.raman.autofocus.roi.x).toBe(1208);
	});

	it("honors an explicit ROI override and displays the supplied coordinates", async () => {
		const { context, spec } = setup();
		spec.domain.raman.autofocus.roi = { x: 10, y: 20, width: 100, height: 80 };
		const result = await proposeRunTool.execute("override", {
			spec, templateApplication: { ...selection, overriddenFields: ["domain.raman.autofocus.roi"] },
		}, undefined, undefined, context);
		expect(result.details.status, result.content[0].text).toBe("success");
		expect(result.content[0].text).toContain("x=10, y=20, width=100, height=80");
		expect(result.details.stateAfter.autofocusRoiSource).toBeUndefined();
	});

	it.each(["version", "missing", "camera", "invalid"])("rejects %s mismatches instead of silently reinterpreting the ROI", async (condition) => {
		const { context, spec, template, path } = setup();
		const application = { ...selection };
		if (condition === "version") application.templateVersion = "old";
		if (condition === "missing") application.templateId = "missing";
		if (condition === "camera") spec.resources = spec.resources.map((resource) => resource.role === "frame_provider" ? { ...resource, resourceId: "another-camera" } : resource);
		if (condition === "invalid") {
			template.defaults.domain.raman.autofocus.roi = { ...reviewedRoi, x: -1 };
			writeFileSync(path, JSON.stringify(template));
		}
		for (const tool of [validateProcedureSpecTool, runPreflightTool, proposeRunTool]) {
			const result = await tool.execute("bad-template", { spec, templateApplication: application }, undefined, undefined, context);
			expect(result.details.status).toBe("error");
		}
	});

	it("revises the frozen coordinates without rereading changed templates and clears source after an ROI override", async () => {
		const { context, cwd, spec, template, path } = setup();
		const original = await proposeRunTool.execute("original", { spec, templateApplication: selection }, undefined, undefined, context);
		template.defaults.domain.raman.autofocus.roi = { ...reviewedRoi, x: 20 };
		writeFileSync(path, JSON.stringify(template));
		const revised = await reviseProposalTool.execute("revise", {
			proposalId: String(original.details.stateAfter.proposalId), patch: { domain: { raman: { acquisition: { laserPowerPercent: 2 } } } },
		}, undefined, undefined, context);
		expect(revised.content[0].text).toContain("x=491, y=352, width=225, height=225");
		expect(revised.content[0].text).toContain("camera-grid@1");
		const override = await reviseProposalTool.execute("override", {
			proposalId: String(revised.details.stateAfter.proposalId), patch: { domain: { raman: { autofocus: { roi: { x: 10 } } } } },
		}, undefined, undefined, context);
		expect(override.content[0].text).toContain("x=10, y=352, width=225, height=225");
		expect(override.details.stateAfter.autofocusRoiSource).toBeUndefined();
		expect(findProcedureProposal(cwd, String(override.details.stateAfter.proposalId))?.specHash).not.toBe(original.details.stateAfter.specHash);
	});
});
