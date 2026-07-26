import type { ProcedureSpec } from "../schemas/index.ts";
import { readProcedureSpec, saveFrozenProcedureSpec } from "../store/procedure-spec-store.ts";
import {
	approveProcedureProposal,
	findProcedureProposal,
	hashProcedureSpec,
	type ProcedureProposalRecord,
} from "../store/proposal-store.ts";

export type ExecutionMode = "simulation" | "live-supervised";

export interface RunAdmission {
	preflightReady: boolean;
	controlAvailable: boolean;
}

export interface OperatorApproval {
	acknowledgedProposalId: string;
	acknowledgedSpecHash: string;
	approvedBy: "user";
	approvedAt: string;
}

export interface ApproveAndFreezeInput {
	cwd: string;
	proposalId: string;
	/**
	 * The proposal's specHash as quoted by the caller. The stored proposal already holds the
	 * spec, so this is a checksum against the right proposal, not a source of spec content.
	 */
	specHash: string;
	mode: ExecutionMode;
	admission?: RunAdmission;
	operatorApproval?: OperatorApproval;
}

export interface ApprovedFrozenProcedureSpec {
	approvedProposal: ProcedureProposalRecord;
	frozenSpec: ProcedureSpec;
}

export class RunAdmissionError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly stateAfter: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "RunAdmissionError";
	}
}

function assertLiveAdmission(mode: ExecutionMode, admission: RunAdmission | undefined): void {
	if (mode !== "live-supervised") {
		return;
	}

	if (!admission?.preflightReady) {
		throw new RunAdmissionError(
			"Live supervised execution requires preflightReady=true before approval and start.",
			"preflight_not_ready",
			{ executionMode: mode, admission },
		);
	}

	if (!admission.controlAvailable) {
		throw new RunAdmissionError(
			"Live supervised execution requires controlAvailable=true before approval and start.",
			"control_not_available",
			{ executionMode: mode, admission },
		);
	}
}

function assertOperatorApproval(
	mode: ExecutionMode,
	proposal: ProcedureProposalRecord,
	operatorApproval: OperatorApproval | undefined,
): void {
	if (mode !== "live-supervised") {
		return;
	}

	if (!operatorApproval) {
		throw new RunAdmissionError(
			"Live supervised execution requires explicit user approval of the proposal before hardware motion or laser acquisition.",
			"operator_approval_required",
			{
				executionMode: mode,
				proposalId: proposal.proposalId,
				specHash: proposal.specHash,
			},
		);
	}

	if (operatorApproval.acknowledgedProposalId !== proposal.proposalId) {
		throw new RunAdmissionError(
			`Operator approval acknowledged proposal ${operatorApproval.acknowledgedProposalId}, not ${proposal.proposalId}.`,
			"operator_approval_proposal_mismatch",
			{
				executionMode: mode,
				proposalId: proposal.proposalId,
				acknowledgedProposalId: operatorApproval.acknowledgedProposalId,
			},
		);
	}

	if (operatorApproval.acknowledgedSpecHash !== proposal.specHash) {
		throw new RunAdmissionError(
			"Operator approval acknowledged a different ProcedureSpec hash.",
			"operator_approval_spec_hash_mismatch",
			{
				executionMode: mode,
				proposalId: proposal.proposalId,
				specHash: proposal.specHash,
				acknowledgedSpecHash: operatorApproval.acknowledgedSpecHash,
			},
		);
	}
}

function freezeProcedureSpec(cwd: string, spec: ProcedureSpec, specHash: string): ProcedureSpec {
	const frozenSpec = readProcedureSpec(cwd, spec.experimentId, spec.procedureSpecId);
	if (!frozenSpec) {
		saveFrozenProcedureSpec(cwd, spec);
		return spec;
	}

	if (hashProcedureSpec(frozenSpec) !== specHash) {
		throw new RunAdmissionError(
			`Frozen ProcedureSpec ${spec.procedureSpecId} does not match the approved proposal.`,
			"frozen_spec_mismatch",
			{
				procedureSpecId: spec.procedureSpecId,
			},
		);
	}

	return frozenSpec;
}

export function approveAndFreezeProcedureSpec(input: ApproveAndFreezeInput): ApprovedFrozenProcedureSpec {
	const proposal = findProcedureProposal(input.cwd, input.proposalId);
	if (!proposal) {
		throw new RunAdmissionError(`Proposal ${input.proposalId} was not found.`, "proposal_not_found");
	}

	if (proposal.status !== "proposed") {
		throw new RunAdmissionError(
			`Proposal ${input.proposalId} is ${proposal.status}, not pending approval.`,
			"proposal_not_pending",
			{ status: proposal.status, supersededBy: proposal.supersededBy },
		);
	}

	if (input.specHash !== proposal.specHash) {
		throw new RunAdmissionError(
			`Proposal ${input.proposalId} has specHash ${proposal.specHash}, not the supplied ${input.specHash}. Approval rejected.`,
			"proposal_spec_mismatch",
			{ proposalId: proposal.proposalId, specHash: proposal.specHash, suppliedSpecHash: input.specHash },
		);
	}

	assertLiveAdmission(input.mode, input.admission);
	assertOperatorApproval(input.mode, proposal, input.operatorApproval);

	const frozenSpec = freezeProcedureSpec(input.cwd, proposal.spec, proposal.specHash);
	const approvedProposal = approveProcedureProposal(input.cwd, proposal);

	return {
		approvedProposal,
		frozenSpec,
	};
}
