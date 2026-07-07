import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import guardrailExtension from "../src/extensions/guardrail/index.ts";
import experimentResearchExtension from "../src/extensions/experiment-research/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "labagents-smoke-")));

function fail(message) {
	console.error(message);
	process.exit(1);
}

function createExtensionApi() {
	const tools = new Map();
	const handlers = new Map();
	let activeTools = ["read", "write", "grep", "ls", "bash"];
	return {
		api: {
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			on(event, handler) {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(toolNames) {
				activeTools = toolNames;
			},
		},
		tools,
		handlers,
	};
}

async function runToolCallHandlers(handlers, event) {
	for (const handler of handlers.get("tool_call") ?? []) {
		const result = await handler(event, { cwd: workspace });
		if (result?.block) {
			return result;
		}
	}
	return {};
}

try {
	execFileSync(join(repoRoot, "deploy/setup-workspace.sh"), [workspace], { stdio: "inherit" });

	const settings = JSON.parse(readFileSync(join(workspace, ".pi/settings.json"), "utf8"));
	const policy = JSON.parse(readFileSync(join(workspace, ".pi/labagents-policy.json"), "utf8"));
	const runtimeConfig = JSON.parse(readFileSync(join(workspace, "lab-config/raman-runtime.lab.json"), "utf8"));

	if (!settings.extensions.every((entry) => entry.startsWith(join(repoRoot, "src/extensions")))) {
		fail("settings.json does not use absolute labagents extension paths under src/extensions.");
	}
	if (policy.workspaceRoot !== workspace) {
		fail("policy workspaceRoot does not match the generated workspace.");
	}
	if (runtimeConfig.pythonRoot !== "lab-config/drivers/raman-python") {
		fail("runtime lab config does not point pythonRoot at the deployed workspace driver copy.");
	}
	if (!existsSync(join(workspace, "lab-config/drivers/raman-python/raman_runtime_daemon.py"))) {
		fail("setup did not deploy the Raman Python driver copy into lab-config/drivers.");
	}

	const extension = createExtensionApi();
	guardrailExtension(extension.api);
	experimentResearchExtension(extension.api);
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, { cwd: workspace });
	}

	const capabilities = await extension.tools
		.get("get_lab_capabilities")
		?.execute("capabilities", {}, undefined, undefined, { cwd: workspace });
	if (capabilities?.details?.status !== "success") {
		fail("get_lab_capabilities did not return success.");
	}

	const recordResult = await extension.tools
		.get("record_experiment_intent")
		?.execute(
			"intent",
			{
				intent: {
					intentId: "intent-smoke-001",
					experimentId: "exp-smoke-001",
					objective: "Verify LabAgents workspace smoke behavior",
					hypothesis: "records stay in workspace",
					constraints: { mode: "offline" },
					successCriteria: ["intent recorded"],
				},
			},
			undefined,
			undefined,
			{ cwd: workspace },
		);
	if (recordResult?.details?.status !== "success") {
		fail("record_experiment_intent did not return success.");
	}

	const allowedRecordPath = join(workspace, "lab-records/smoke.txt");
	writeFileSync(allowedRecordPath, "ok\n", "utf8");

	const blockedRead = await runToolCallHandlers(extension.handlers, {
		type: "tool_call",
		toolCallId: "blocked-read",
		toolName: "read",
		input: { path: join(repoRoot, "src/extensions/experiment-research/index.ts") },
	});
	if (!blockedRead.block) {
		fail("guardrail did not block reading labagents source.");
	}

	const blockedGrep = await runToolCallHandlers(extension.handlers, {
		type: "tool_call",
		toolCallId: "blocked-grep",
		toolName: "grep",
		input: { pattern: "ExtensionAPI", path: repoRoot },
	});
	if (!blockedGrep.block) {
		fail("guardrail did not block grep over labagents source.");
	}

	const allowedWrite = await runToolCallHandlers(extension.handlers, {
		type: "tool_call",
		toolCallId: "allowed-write",
		toolName: "write",
		input: { path: allowedRecordPath, content: "ok\n" },
	});
	if (allowedWrite.block) {
		fail(`guardrail unexpectedly blocked workspace write: ${allowedWrite.reason}`);
	}

	console.log(`mac smoke passed: ${workspace}`);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
