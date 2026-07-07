import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export interface GuardrailBashPolicy {
	mode: "workspace-only";
	blockedPathSubstrings: string[];
}

export interface GuardrailPolicy {
	workspaceRoot: string;
	protectedRoots: string[];
	allowReadWithinWorkspace: boolean;
	allowWriteWithinWorkspace: boolean;
	allowSearchWithinWorkspace: boolean;
	allowListWithinWorkspace: boolean;
	bash: GuardrailBashPolicy;
}

export interface GuardrailDecision {
	block: boolean;
	reason?: string;
}

type AccessKind = "read" | "write" | "search" | "list";

const POLICY_PATH = ".pi/labagents-policy.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		return undefined;
	}
	return value;
}

function normalizeExistingPath(path: string): string {
	return realpathSync(path);
}

function normalizePathForPolicy(path: string): string {
	if (existsSync(path)) {
		return normalizeExistingPath(path);
	}
	const parent = dirname(path);
	if (existsSync(parent)) {
		return resolve(normalizeExistingPath(parent), path.slice(parent.length + 1));
	}
	return resolve(path);
}

function pathStartsWith(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function readPolicyFile(cwd: string): GuardrailPolicy {
	const policyPath = resolve(cwd, POLICY_PATH);
	const raw = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
	if (!isRecord(raw)) {
		throw new Error("LabAgents guardrail policy must be a JSON object.");
	}
	const bash = raw.bash;
	if (!isRecord(bash)) {
		throw new Error("LabAgents guardrail policy is missing bash settings.");
	}
	const protectedRoots = readStringArray(raw.protectedRoots);
	const blockedPathSubstrings = readStringArray(bash.blockedPathSubstrings);
	if (
		typeof raw.workspaceRoot !== "string" ||
		!protectedRoots ||
		typeof raw.allowReadWithinWorkspace !== "boolean" ||
		typeof raw.allowWriteWithinWorkspace !== "boolean" ||
		typeof raw.allowSearchWithinWorkspace !== "boolean" ||
		typeof raw.allowListWithinWorkspace !== "boolean" ||
		bash.mode !== "workspace-only" ||
		!blockedPathSubstrings
	) {
		throw new Error("LabAgents guardrail policy has an invalid shape.");
	}
	return {
		workspaceRoot: normalizeExistingPath(raw.workspaceRoot),
		protectedRoots: protectedRoots.map((root) => normalizePathForPolicy(root)),
		allowReadWithinWorkspace: raw.allowReadWithinWorkspace,
		allowWriteWithinWorkspace: raw.allowWriteWithinWorkspace,
		allowSearchWithinWorkspace: raw.allowSearchWithinWorkspace,
		allowListWithinWorkspace: raw.allowListWithinWorkspace,
		bash: {
			mode: "workspace-only",
			blockedPathSubstrings,
		},
	};
}

function resolveToolPath(path: string, cwd: string): string {
	const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
	return normalizePathForPolicy(absolutePath);
}

function accessEnabled(policy: GuardrailPolicy, kind: AccessKind): boolean {
	switch (kind) {
		case "read":
			return policy.allowReadWithinWorkspace;
		case "write":
			return policy.allowWriteWithinWorkspace;
		case "search":
			return policy.allowSearchWithinWorkspace;
		case "list":
			return policy.allowListWithinWorkspace;
	}
}

function checkWorkspacePath(policy: GuardrailPolicy, path: string, kind: AccessKind): GuardrailDecision {
	if (!accessEnabled(policy, kind)) {
		return { block: true, reason: `LabAgents guardrail blocks ${kind} operations by policy.` };
	}
	for (const protectedRoot of policy.protectedRoots) {
		if (pathStartsWith(path, protectedRoot)) {
			return { block: true, reason: `LabAgents guardrail blocked ${kind} access to protected path: ${path}` };
		}
	}
	if (!pathStartsWith(path, policy.workspaceRoot)) {
		return { block: true, reason: `LabAgents guardrail blocked ${kind} access outside workspace: ${path}` };
	}
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
		const target = normalizeExistingPath(path);
		if (!pathStartsWith(target, policy.workspaceRoot)) {
			return { block: true, reason: `LabAgents guardrail blocked symlink escaping workspace: ${path}` };
		}
	}
	return { block: false };
}

function getInputPath(input: Record<string, unknown>, names: string[]): string | undefined {
	for (const name of names) {
		const value = input[name];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function checkPathInput(
	policy: GuardrailPolicy,
	cwd: string,
	event: ToolCallEvent,
	kind: AccessKind,
	pathNames: string[],
): GuardrailDecision {
	const input = event.input;
	if (!isRecord(input)) {
		return { block: true, reason: `LabAgents guardrail could not inspect ${event.toolName} input.` };
	}
	const path = getInputPath(input, pathNames);
	if (!path) {
		return { block: true, reason: `LabAgents guardrail requires an explicit path for ${event.toolName}.` };
	}
	return checkWorkspacePath(policy, resolveToolPath(path, cwd), kind);
}

function extractBashCommand(input: Record<string, unknown>): string | undefined {
	const command = input.command;
	if (typeof command === "string") {
		return command;
	}
	const cmd = input.cmd;
	return typeof cmd === "string" ? cmd : undefined;
}

function checkBash(policy: GuardrailPolicy, cwd: string, event: ToolCallEvent): GuardrailDecision {
	const input = event.input;
	if (!isRecord(input)) {
		return { block: true, reason: "LabAgents guardrail could not inspect bash input." };
	}
	const command = extractBashCommand(input);
	if (!command) {
		return { block: true, reason: "LabAgents guardrail requires an explicit bash command." };
	}
	const requestedCwd = getInputPath(input, ["cwd", "workdir"]);
	if (requestedCwd) {
		const cwdDecision = checkWorkspacePath(policy, resolveToolPath(requestedCwd, cwd), "read");
		if (cwdDecision.block) {
			return cwdDecision;
		}
	}
	for (const protectedRoot of policy.protectedRoots) {
		if (command.includes(protectedRoot)) {
			return { block: true, reason: `LabAgents guardrail blocked bash command referencing protected path: ${protectedRoot}` };
		}
	}
	for (const blocked of policy.bash.blockedPathSubstrings) {
		if (blocked && command.includes(blocked)) {
			return { block: true, reason: `LabAgents guardrail blocked bash command referencing protected path: ${blocked}` };
		}
	}
	if (/\bcd\s+(\.\.|\S*labagents|\S*pi\/packages)/u.test(command)) {
		return { block: true, reason: "LabAgents guardrail blocked bash command that appears to leave the workspace." };
	}
	return { block: false };
}

export function decideToolCall(policy: GuardrailPolicy, cwd: string, event: ToolCallEvent): GuardrailDecision {
	const normalizedPolicy: GuardrailPolicy = {
		...policy,
		workspaceRoot: normalizePathForPolicy(policy.workspaceRoot),
		protectedRoots: policy.protectedRoots.map((root) => normalizePathForPolicy(root)),
	};
	switch (event.toolName) {
		case "read":
			return checkPathInput(normalizedPolicy, cwd, event, "read", ["path", "file_path"]);
		case "edit":
		case "write":
			return checkPathInput(normalizedPolicy, cwd, event, "write", ["path", "file_path"]);
		case "grep":
		case "find":
			return checkPathInput(normalizedPolicy, cwd, event, "search", ["path", "directory", "cwd"]);
		case "ls":
			return checkPathInput(normalizedPolicy, cwd, event, "list", ["path", "directory"]);
		case "bash":
			return checkBash(normalizedPolicy, cwd, event);
		default:
			return { block: false };
	}
}

export function decideToolCallFromContext(event: ToolCallEvent, ctx: ExtensionContext): GuardrailDecision {
	if (!ctx.cwd) {
		return { block: true, reason: "LabAgents guardrail requires a workspace cwd." };
	}
	try {
		const policy = readPolicyFile(ctx.cwd);
		return decideToolCall(policy, ctx.cwd, event);
	} catch (error) {
		return {
			block: true,
			reason: error instanceof Error ? error.message : "LabAgents guardrail could not load policy.",
		};
	}
}
