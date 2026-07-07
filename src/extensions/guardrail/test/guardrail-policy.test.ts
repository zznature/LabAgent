import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideToolCall, type GuardrailPolicy } from "../policy.ts";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "labagents-guardrail-"));
	tempRoots.push(root);
	const workspace = join(root, "workspace");
	const labagents = join(root, "labagents");
	const pi = join(root, "pi");
	mkdirSync(join(workspace, "lab-config"), { recursive: true });
	mkdirSync(join(workspace, "lab-records"), { recursive: true });
	mkdirSync(join(labagents, "src/extensions/experiment-research"), { recursive: true });
	mkdirSync(join(pi, "packages"), { recursive: true });
	writeFileSync(join(workspace, "lab-config/user-prompts.md"), "# User Prompts\n", "utf8");
	writeFileSync(join(workspace, "lab-records/intent.json"), "{}\n", "utf8");
	writeFileSync(join(labagents, "src/extensions/experiment-research/index.ts"), "export default function extension() {}\n", "utf8");
	writeFileSync(join(pi, "packages/runtime.ts"), "export const runtime = true;\n", "utf8");
	const policy: GuardrailPolicy = {
		workspaceRoot: workspace,
		protectedRoots: [labagents, pi],
		allowReadWithinWorkspace: true,
		allowWriteWithinWorkspace: true,
		allowSearchWithinWorkspace: true,
		allowListWithinWorkspace: true,
		bash: {
			mode: "workspace-only",
			blockedPathSubstrings: [labagents, pi],
		},
	};
	return { root, workspace, labagents, pi, policy };
}

function event(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: `${toolName}-call`,
		toolName,
		input,
	} as ToolCallEvent;
}

describe("LabAgents guardrail policy", () => {
	it("allows read and write operations inside the lab workspace", () => {
		const { workspace, policy } = createFixture();

		expect(
			decideToolCall(policy, workspace, event("read", { path: "lab-config/user-prompts.md" })).block,
		).toBe(false);
		expect(
			decideToolCall(policy, workspace, event("write", { path: "lab-records/intent.json" })).block,
		).toBe(false);
	});

	it("blocks read, write, search, and list operations against labagents source", () => {
		const { workspace, labagents, policy } = createFixture();

		expect(decideToolCall(policy, workspace, event("read", { path: join(labagents, "src/extensions/experiment-research/index.ts") })).block).toBe(true);
		expect(decideToolCall(policy, workspace, event("write", { path: join(labagents, "README.md") })).block).toBe(true);
		expect(decideToolCall(policy, workspace, event("grep", { pattern: "extension", path: labagents })).block).toBe(true);
		expect(decideToolCall(policy, workspace, event("ls", { path: labagents })).block).toBe(true);
	});

	it("blocks access to the pi fork packages directory", () => {
		const { workspace, pi, policy } = createFixture();

		expect(decideToolCall(policy, workspace, event("read", { path: join(pi, "packages/runtime.ts") })).block).toBe(true);
		expect(decideToolCall(policy, workspace, event("find", { path: join(pi, "packages") })).block).toBe(true);
	});

	it("blocks bash commands that reference protected roots and allows workspace-only commands", () => {
		const { workspace, labagents, policy } = createFixture();

		expect(decideToolCall(policy, workspace, event("bash", { command: `cat ${join(labagents, "README.md")}` })).block).toBe(true);
		expect(decideToolCall(policy, workspace, event("bash", { command: "pwd && ls .pi", cwd: workspace })).block).toBe(false);
	});

	it("blocks symlinks that escape the workspace", () => {
		const { workspace, labagents, policy } = createFixture();
		const linkPath = join(workspace, "lab-config/source-link");
		symlinkSync(join(labagents, "src/extensions/experiment-research/index.ts"), linkPath);

		expect(decideToolCall(policy, workspace, event("read", { path: linkPath })).block).toBe(true);
	});
});
