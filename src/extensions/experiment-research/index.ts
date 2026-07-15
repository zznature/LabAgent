import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RAMAN_EXTENSION_PROMPT } from "./prompt.ts";
import {
	ramanAcquireSmokeSpectrumTool,
	ramanCaptureFrameTool,
	ramanCaptureLaserOffFrameTool,
	ramanGetHardwareStatusTool,
	ramanGetStagePositionTool,
	ramanRunAutofocusTool,
	ramanStageMoveRelativeTool,
} from "./tools/operator.ts";
import {
	findExperimentProcedureTemplateTool,
	getLabCapabilitiesTool,
	getLabStateTool,
	getProcedureSpecTemplateTool,
	recordExperimentIntentTool,
	runPreflightTool,
	validateProcedureSpecTool,
} from "./tools/planner.ts";
import {
	abortRunTool,
	approveAndStartRunTool,
	pauseRunTool,
	pollRunTool,
	proposeRunTool,
	runProcedureTool,
	summarizeRunTool,
} from "./tools/runtime.ts";
import { registerConfiguredRamanPythonRuntime } from "./runtime/raman/index.ts";

const PLANNER_TOOL_NAMES = [
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
	"raman_capture_frame",
	"raman_capture_laser_off_frame",
	"raman_run_autofocus",
	"raman_acquire_smoke_spectrum",
	"raman_stage_move_relative",
];

const LAB_LOCAL_PROMPT_PATH = join("lab-config", "user-prompts.md");

function loadLabLocalPrompt(cwd: string | undefined): string | undefined {
	if (!cwd) {
		return undefined;
	}
	const promptPath = join(cwd, LAB_LOCAL_PROMPT_PATH);
	if (!existsSync(promptPath)) {
		return undefined;
	}
	const prompt = readFileSync(promptPath, "utf8").trim();
	return prompt.length > 0 ? prompt : undefined;
}

export default function experimentResearchExtension(pi: ExtensionAPI) {
	pi.registerTool(getLabCapabilitiesTool);
	pi.registerTool(getLabStateTool);
	pi.registerTool(recordExperimentIntentTool);
	pi.registerTool(findExperimentProcedureTemplateTool);
	pi.registerTool(getProcedureSpecTemplateTool);
	pi.registerTool(validateProcedureSpecTool);
	pi.registerTool(runPreflightTool);
	pi.registerTool(ramanGetHardwareStatusTool);
	pi.registerTool(ramanGetStagePositionTool);
	pi.registerTool(ramanCaptureFrameTool);
	pi.registerTool(ramanCaptureLaserOffFrameTool);
	pi.registerTool(ramanRunAutofocusTool);
	pi.registerTool(ramanAcquireSmokeSpectrumTool);
	pi.registerTool(ramanStageMoveRelativeTool);
	pi.registerTool(proposeRunTool);
	pi.registerTool(approveAndStartRunTool);
	pi.registerTool(runProcedureTool);
	pi.registerTool(pollRunTool);
	pi.registerTool(summarizeRunTool);
	pi.registerTool(pauseRunTool);
	pi.registerTool(abortRunTool);

	pi.on("session_start", (_event, ctx) => {
		if (ctx?.cwd) {
			registerConfiguredRamanPythonRuntime(ctx.cwd);
		}
		const activeTools = new Set(pi.getActiveTools());
		for (const toolName of PLANNER_TOOL_NAMES) {
			activeTools.add(toolName);
		}
		pi.setActiveTools([...activeTools]);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const promptParts = [event.systemPrompt, RAMAN_EXTENSION_PROMPT];
		const labLocalPrompt = loadLabLocalPrompt(ctx?.cwd);
		if (labLocalPrompt) {
			promptParts.push(labLocalPrompt);
		}
		return {
			systemPrompt: promptParts.join("\n\n"),
		};
	});
}
