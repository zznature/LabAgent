import { createHash, randomUUID } from "node:crypto";
import type { ProcedureSpec } from "../schemas/procedure-spec.ts";
import { experimentRoot, experimentsRoot } from "./layout.ts";
import { listDirectories, listJsonFiles, readJsonFile, writeJsonFile } from "./storage.ts";
import { join } from "node:path";

export type ProposalStatus = "proposed" | "approved";

export interface ProcedureProposalRecord {
	proposalId: string;
	experimentId: string;
	procedureSpecId: string;
	specHash: string;
	status: ProposalStatus;
	requiresConfirmation: true;
	spec: ProcedureSpec;
	createdAt: string;
	approvedAt?: string;
}

function stableCanonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalize(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableCanonicalize(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function now(): string {
	return new Date().toISOString();
}

function proposalsRoot(cwd: string, experimentId: string): string {
	return join(experimentRoot(cwd, experimentId), "proposals");
}

function proposalPath(cwd: string, experimentId: string, proposalId: string): string {
	return join(proposalsRoot(cwd, experimentId), `${proposalId}.json`);
}

export function hashProcedureSpec(spec: ProcedureSpec): string {
	return createHash("sha256").update(stableCanonicalize(spec)).digest("hex");
}

export function createProcedureProposal(cwd: string, spec: ProcedureSpec): ProcedureProposalRecord {
	const proposal: ProcedureProposalRecord = {
		proposalId: `proposal-${randomUUID().slice(0, 8)}`,
		experimentId: spec.experimentId,
		procedureSpecId: spec.procedureSpecId,
		specHash: hashProcedureSpec(spec),
		status: "proposed",
		requiresConfirmation: true,
		spec,
		createdAt: now(),
	};
	writeJsonFile(proposalPath(cwd, spec.experimentId, proposal.proposalId), proposal);
	return proposal;
}

export function readProcedureProposal(
	cwd: string,
	experimentId: string,
	proposalId: string,
): ProcedureProposalRecord | undefined {
	return readJsonFile<ProcedureProposalRecord>(proposalPath(cwd, experimentId, proposalId));
}

export function findProcedureProposal(cwd: string, proposalId: string): ProcedureProposalRecord | undefined {
	for (const experimentId of listDirectories(experimentsRoot(cwd))) {
		const proposal = readProcedureProposal(cwd, experimentId, proposalId);
		if (proposal) {
			return proposal;
		}
	}
	return undefined;
}

export function listProcedureProposals(cwd: string, experimentId: string): ProcedureProposalRecord[] {
	return listJsonFiles(proposalsRoot(cwd, experimentId))
		.map((fileName) => readProcedureProposal(cwd, experimentId, fileName.replace(/\.json$/u, "")))
		.filter((proposal): proposal is ProcedureProposalRecord => proposal !== undefined);
}

export function approveProcedureProposal(cwd: string, proposal: ProcedureProposalRecord): ProcedureProposalRecord {
	const approved: ProcedureProposalRecord = {
		...proposal,
		status: "approved",
		approvedAt: now(),
	};
	writeJsonFile(proposalPath(cwd, proposal.experimentId, proposal.proposalId), approved);
	return approved;
}
