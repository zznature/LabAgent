import { describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
	getActiveTools(): string[];
}

function loadExperimentExtension(): CapturedExtension {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, CapturedHandler[]>();
	let activeTools = ["read"];
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: CapturedHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(toolNames: string[]) {
			activeTools = toolNames;
		},
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers, getActiveTools: () => activeTools };
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	return value as Record<string, unknown>;
}

describe("experiment research rebuild skeleton", () => {
	it("loads the canonical extension and registers the phase-1 read-only tools", async () => {
		const extension = loadExperimentExtension();
		const [sessionStart] = extension.handlers.get("session_start") ?? [];
		const [beforeAgentStart] = extension.handlers.get("before_agent_start") ?? [];

		expect(extension.tools.has("get_lab_capabilities")).toBe(true);
		expect(extension.tools.has("get_lab_state")).toBe(true);
		expect(extension.tools.has("record_experiment_intent")).toBe(true);
		expect(extension.tools.has("find_experiment_procedure_template")).toBe(true);
		expect(extension.tools.has("get_procedure_spec_template")).toBe(true);
		expect(extension.tools.has("validate_procedure_spec")).toBe(true);
		expect(extension.tools.has("run_preflight")).toBe(true);
		expect(extension.tools.has("propose_run")).toBe(true);
		expect(extension.tools.has("approve_and_start_run")).toBe(true);
		expect(extension.tools.has("run_procedure")).toBe(true);
		expect(extension.tools.has("poll_run")).toBe(true);
		expect(extension.tools.has("summarize_run")).toBe(true);
		expect(extension.tools.has("pause_run")).toBe(true);
		expect(extension.tools.has("abort_run")).toBe(true);
		expect(extension.handlers.get("session_start")).toHaveLength(1);
		expect(extension.handlers.get("before_agent_start")).toHaveLength(1);

		await sessionStart?.({ type: "session_start", reason: "startup" }, { cwd: REPO_ROOT } as ExtensionContext);
		expect(extension.getActiveTools()).toEqual(
			expect.arrayContaining([
				"read",
				"get_lab_capabilities",
				"get_lab_state",
				"record_experiment_intent",
				"find_experiment_procedure_template",
				"get_procedure_spec_template",
				"validate_procedure_spec",
				"run_preflight",
				"propose_run",
				"approve_and_start_run",
				"poll_run",
				"summarize_run",
				"pause_run",
				"abort_run",
				"raman_get_hardware_status",
				"raman_get_stage_position",
				"raman_stage_move_relative",
			]),
		);

		const promptResult = asRecord(
			beforeAgentStart?.({
				type: "before_agent_start",
				prompt: "plan an experiment",
				systemPrompt: "base prompt",
				systemPromptOptions: {},
			}, { cwd: REPO_ROOT } as ExtensionContext),
		);
		expect(promptResult.systemPrompt).toContain("base prompt");
		expect(promptResult.systemPrompt).toContain("Raman Extension Prompt");
		expect(promptResult.systemPrompt).toContain("raman_get_hardware_status");
		expect(promptResult.systemPrompt).toContain("Raman hardware");
		expect(promptResult.systemPrompt).toContain("record_experiment_intent");
		expect(promptResult.systemPrompt).toContain("find_experiment_procedure_template");
		expect(promptResult.systemPrompt).toContain("get_procedure_spec_template");
		expect(promptResult.systemPrompt).toContain("summarize_run");
		expect(promptResult.systemPrompt).toContain("propose_run followed by approve_and_start_run");
	});

	it("returns scaffold details for the read-only tools", async () => {
		const extension = loadExperimentExtension();
		const context = { cwd: REPO_ROOT } as ExtensionContext;

		const capabilities = await extension.tools
			.get("get_lab_capabilities")
			?.execute("capabilities", {}, undefined, undefined, context);
		const capabilitiesDetails = asRecord(capabilities?.details);
		expect(capabilitiesDetails.status).toBe("success");
		expect(capabilitiesDetails.summary).toBe("LabAgents MVP rebuild planner capabilities loaded.");
		const capabilitiesState = asRecord(capabilitiesDetails.stateAfter);
		const planningDefaults = asRecord(capabilitiesState.planningDefaults);
		expect(planningDefaults.resources).toEqual([
			{ resourceId: "stage-main", role: "stage" },
			{ resourceId: "frame-main", role: "frame_provider" },
			{ resourceId: "spectrometer-main", role: "spectrometer" },
		]);
		expect(planningDefaults.autofocusRoi).toEqual({ x: 492, y: 353, width: 225, height: 225 });

		const labState = await extension.tools
			.get("get_lab_state")
			?.execute("lab-state", {}, undefined, undefined, context);
		const stateDetails = asRecord(labState?.details);
		const stateAfter = asRecord(stateDetails.stateAfter);
		expect(stateDetails.status).toBe("success");
		expect(stateDetails.summary).toBe("LabAgents planner proposal flow is active.");
		expect(stateAfter.canExecuteSimulationRuns).toBe(true);
		expect(typeof stateAfter.canExecuteLiveSinglePointRuns).toBe("boolean");
		expect(stateAfter.canValidateProcedureSpecs).toBe(true);
		expect(stateAfter.canRunPreflight).toBe(true);
		expect(stateAfter.requiresApproval).toBe(true);
	});
});
