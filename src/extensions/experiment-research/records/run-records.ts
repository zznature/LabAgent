import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	operatorArtifactIndexPath,
	operatorArtifactRoot,
	operatorOperationPath,
	operatorOperationRoot,
	runArtifactIndexPath,
	runArtifactRoot,
	runObservationEventsPath,
	runObservationPath,
	runRoot,
	runsRoot,
} from "../store/layout.ts";
import { appendJsonLine, readJsonFile, readJsonLines, writeJsonFileAtomic } from "../store/storage.ts";

export interface RunObservationPoint {
	row?: number;
	col?: number;
	xUm: number;
	yUm: number;
	zUm?: number;
}

export type UnitObservationStatus = "pending" | "running" | "waiting_retry" | "succeeded" | "failed" | "cancelled";

export interface UnitObservation {
	unitId: string;
	index: number;
	point?: RunObservationPoint;
	status: UnitObservationStatus;
	activeAttemptId?: string;
	acceptedAttemptId?: string;
	attemptCount: number;
	canonicalArtifactIds: string[];
	startedAt?: string;
	endedAt?: string;
}

export interface RunObservationSnapshot {
	schemaVersion: 1;
	runId: string;
	experimentId: string;
	procedureSpecId: string;
	throughSequence: number;
	status: "queued" | "running" | "paused" | "aborted" | "failed" | "completed";
	progress: {
		completedUnits: number;
		failedUnits: number;
		totalUnits: number;
	};
	units: UnitObservation[];
	heartbeatAt?: string;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
}

export type RunObservationChange =
	| { type: "run_started"; timestamp: string }
	| { type: "run_paused"; timestamp: string }
	| { type: "run_aborted"; timestamp: string }
	| { type: "run_failed"; timestamp: string }
	| { type: "run_completed"; timestamp: string }
	| { type: "attempt_started"; unitId: string; attemptId: string; timestamp: string }
	| { type: "attempt_failed"; unitId: string; attemptId: string; willRetry: boolean; timestamp: string }
	| {
			type: "attempt_accepted";
			unitId: string;
			attemptId: string;
			canonicalArtifactIds: string[];
			timestamp: string;
	  }
	| {
			type: "artifact_status_changed";
			artifactId: string;
			status: ArtifactLifecycleStatus;
			timestamp: string;
	  };

export interface RunObservationEvent {
	schemaVersion: 1;
	sequence: number;
	eventId: string;
	runId: string;
	timestamp: string;
	change: RunObservationChange;
}

export interface InitializeRunInput {
	runId: string;
	experimentId: string;
	procedureSpecId: string;
	startedAt: string;
	units: Array<{
		unitId: string;
		index: number;
		point?: RunObservationPoint;
	}>;
}

export type ArtifactLayer = "source" | "canonical" | "diagnostic";
export type ArtifactLifecycleStatus = "pending" | "producing" | "complete" | "failed";
export type CanonicalArtifactProfile = "raman-frame" | "raman-spectrum" | "raman-autofocus" | "raman-evaluation";
export type ArtifactRepresentationRole = "data" | "display" | "thumbnail" | "download" | "source" | "diagnostic";

export interface RunArtifactScope {
	kind: "run";
	runId: string;
	unitId: string;
	attemptId: string;
	actionId: string;
}

export interface OperatorArtifactScope {
	kind: "operator";
	operationId: string;
	relatedRunId?: string;
	actionId: string;
}

export type ArtifactScope = RunArtifactScope | OperatorArtifactScope;

export interface ArtifactRepresentation {
	role: ArtifactRepresentationRole;
	mediaType: string;
	path: string;
	byteSize: number;
	checksum: { algorithm: "sha256"; digest: string };
}

export interface ArtifactDescriptor {
	schemaVersion: 1;
	artifactId: string;
	scope: ArtifactScope;
	layer: ArtifactLayer;
	profile?: CanonicalArtifactProfile;
	status: ArtifactLifecycleStatus;
	sourceArtifactIds: string[];
	data?: Record<string, unknown>;
	representations: ArtifactRepresentation[];
	createdAt: string;
	completedAt?: string;
	error?: { errorCode: string; message: string };
}

export interface PublishArtifactInput {
	artifactId: string;
	scope: ArtifactScope;
	layer: ArtifactLayer;
	profile?: "raman-frame";
	sourceArtifactIds: string[];
	createdAt: string;
	descriptorData?: Record<string, unknown>;
	representations: ArtifactRepresentationCandidate[];
	canonicalData?: never;
}

interface ArtifactRepresentationCandidate {
	role: ArtifactRepresentationRole;
	mediaType: string;
	fileName: string;
	sourcePath?: string;
	content?: string | Buffer;
}

export interface RamanSpectrumCanonicalData {
	schemaVersion: 1;
	xAxis: { kind: string; unit: string; values: number[] };
	yAxis: { kind: string; unit: string; values: number[] };
	acquisition: Record<string, unknown>;
	metrics: Record<string, unknown>;
}

export interface PublishRamanSpectrumInput {
	artifactId: string;
	scope: ArtifactScope;
	layer: "canonical";
	profile: "raman-spectrum";
	sourceArtifactIds: string[];
	createdAt: string;
	canonicalData: RamanSpectrumCanonicalData;
	representations?: never;
}

export interface PublishRamanJsonInput {
	artifactId: string;
	scope: ArtifactScope;
	layer: "canonical";
	profile: "raman-autofocus" | "raman-evaluation";
	sourceArtifactIds: string[];
	createdAt: string;
	canonicalData: Record<string, unknown>;
	representations?: never;
}

export type ArtifactPublicationInput = PublishArtifactInput | PublishRamanSpectrumInput | PublishRamanJsonInput;

export interface ReadRepresentationResult extends ArtifactRepresentation {
	bytes: Buffer;
}

export interface ArtifactFilter {
	layer?: ArtifactLayer;
	profile?: CanonicalArtifactProfile;
	status?: ArtifactLifecycleStatus;
	unitId?: string;
	attemptId?: string;
}

interface ArtifactIndexEntry {
	artifactId: string;
	layer: ArtifactLayer;
	profile?: CanonicalArtifactProfile;
	status: ArtifactLifecycleStatus;
	unitId?: string;
	attemptId?: string;
	descriptorPath: string;
}

interface ArtifactIndex {
	schemaVersion: 1;
	scopeId: string;
	throughSequence: number;
	artifacts: ArtifactIndexEntry[];
}

interface ArtifactPublicationIntent {
	schemaVersion: 1;
	artifactId: string;
	scope: ArtifactScope;
	layer: ArtifactLayer;
	profile?: CanonicalArtifactProfile;
	sourceArtifactIds: string[];
	createdAt: string;
	data?: Record<string, unknown>;
}

export interface RunRecords {
	initializeRun(input: InitializeRunInput): RunObservationSnapshot;
	applyRunChange(runId: string, change: RunObservationChange): RunObservationSnapshot;
	readRun(runId: string): RunObservationSnapshot | undefined;
	readEvents(runId: string, afterSequence: number): RunObservationEvent[];
	initializeOperatorOperation(input: {
		operationId: string;
		operationKind: string;
		relatedRunId?: string;
		startedAt: string;
	}): void;
	recoverInterruptedPublications(runId: string): ArtifactDescriptor[];
	publishArtifact(input: ArtifactPublicationInput): ArtifactDescriptor;
	listArtifacts(runId: string, filter?: ArtifactFilter): ArtifactDescriptor[];
	readArtifact(runId: string, artifactId: string): ArtifactDescriptor | undefined;
	listOperatorArtifacts(operationId: string): ArtifactDescriptor[];
	readOperatorArtifact(operationId: string, artifactId: string): ArtifactDescriptor | undefined;
	readRepresentation(runId: string, artifactId: string, role: string): ReadRepresentationResult;
	readOperatorRepresentation(operationId: string, artifactId: string, role: string): ReadRepresentationResult;
}

const PATH_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function requirePathSafeId(label: string, value: string): void {
	if (!PATH_SAFE_ID.test(value)) {
		throw new Error(`${label} must be a path-safe identifier: ${value}`);
	}
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function spectrumRepresentationCandidates(data: RamanSpectrumCanonicalData): ArtifactRepresentationCandidate[] {
	if (data.xAxis.kind !== "raman_shift" || data.xAxis.unit !== "cm^-1") {
		throw new Error("raman spectrum requires xAxis kind raman_shift with unit cm^-1");
	}
	if (data.yAxis.kind !== "intensity" || data.yAxis.unit.length === 0) {
		throw new Error("raman spectrum requires an explicit intensity unit");
	}
	if (data.xAxis.values.length === 0 || data.xAxis.values.length !== data.yAxis.values.length) {
		throw new Error("raman spectrum axes must contain the same non-zero number of values");
	}
	const csvRows = data.xAxis.values.map((value, index) => `${value},${data.yAxis.values[index]}`).join("\n");
	return [
		{
			role: "data",
			mediaType: "application/json",
			fileName: "spectrum.json",
			content: `${JSON.stringify(data, null, 2)}\n`,
		},
		{
			role: "download",
			mediaType: "text/csv",
			fileName: "spectrum.csv",
			content: `raman_shift_cm-1,intensity_${data.yAxis.unit}\n${csvRows}\n`,
		},
	];
}

function canonicalRepresentationCandidates(input: PublishRamanSpectrumInput | PublishRamanJsonInput): ArtifactRepresentationCandidate[] {
	if (input.profile === "raman-spectrum") {
		return spectrumRepresentationCandidates(input.canonicalData);
	}
	const data = input.canonicalData;
	if (input.profile === "raman-autofocus") {
		if (
			data.schemaVersion !== 1 || typeof data.algorithmVersion !== "string" || !Array.isArray(data.scanPoints) ||
			typeof data.peakEstimate !== "object" || data.peakEstimate === null ||
			typeof data.selectedFocus !== "object" || data.selectedFocus === null ||
			typeof data.finalVerification !== "object" || data.finalVerification === null ||
			typeof data.parameters !== "object" || data.parameters === null ||
			typeof data.frameArtifactIds !== "object" || data.frameArtifactIds === null
		) {
			throw new Error("raman-autofocus canonical data does not match profile v1");
		}
	} else if (
		data.schemaVersion !== 1 || typeof data.ruleSet !== "object" || data.ruleSet === null ||
		typeof data.inputs !== "object" || data.inputs === null ||
		typeof data.thresholds !== "object" || data.thresholds === null || Object.keys(data.thresholds).length === 0 ||
		!Array.isArray(data.rules) || data.rules.length === 0 || typeof data.decision !== "string" || !Array.isArray(data.reasons)
	) {
		throw new Error("raman-evaluation canonical data does not match profile v1");
	}
	return [
		{
			role: "data",
			mediaType: "application/json",
			fileName: input.profile === "raman-autofocus" ? "autofocus.json" : "evaluation.json",
			content: `${JSON.stringify(input.canonicalData, null, 2)}\n`,
		},
	];
}

function validateFrameCandidates(input: PublishArtifactInput, candidates: ArtifactRepresentationCandidate[]): void {
	if (input.profile !== "raman-frame") {
		return;
	}
	const display = candidates.filter((candidate) => candidate.role === "display" && candidate.mediaType === "image/png");
	const thumbnails = candidates.filter((candidate) => candidate.role === "thumbnail" && candidate.mediaType === "image/webp");
	if (input.layer !== "canonical" || input.sourceArtifactIds.length === 0 || candidates.length !== 2 || display.length !== 1 || thumbnails.length !== 1) {
		throw new Error("raman-frame requires canonical PNG display and WebP thumbnail representations with source provenance");
	}
}

export function createRunRecords(cwd: string): RunRecords {
	function updateUnit(
		snapshot: RunObservationSnapshot,
		unitId: string,
		update: (unit: UnitObservation) => UnitObservation,
	): UnitObservation[] {
		let found = false;
		const units = snapshot.units.map((unit) => {
			if (unit.unitId !== unitId) {
				return unit;
			}
			found = true;
			return update(unit);
		});
		if (!found) {
			throw new Error(`run observation unit not found: ${unitId}`);
		}
		return units;
	}

	function listIndexedArtifacts(indexPath: string, root: string, filter?: ArtifactFilter): ArtifactDescriptor[] {
		const index = readJsonFile<ArtifactIndex>(indexPath);
		if (!index) {
			return [];
		}
		return index.artifacts.filter((entry) =>
			(filter?.layer === undefined || entry.layer === filter.layer) &&
			(filter?.profile === undefined || entry.profile === filter.profile) &&
			(filter?.status === undefined || entry.status === filter.status) &&
			(filter?.unitId === undefined || entry.unitId === filter.unitId) &&
			(filter?.attemptId === undefined || entry.attemptId === filter.attemptId),
		).map((entry) => {
			const descriptor = readJsonFile<ArtifactDescriptor>(join(root, entry.descriptorPath));
			if (!descriptor) {
				throw new Error(`artifact descriptor missing: ${entry.artifactId}`);
			}
			return descriptor;
		});
	}

	function readCompleteRepresentation(
		descriptor: ArtifactDescriptor | undefined,
		artifactRoot: string,
		artifactId: string,
		role: string,
	): ReadRepresentationResult {
		if (!descriptor) {
			throw new Error(`artifact not found: ${artifactId}`);
		}
		if (descriptor.status !== "complete") {
			throw new Error(`artifact is not complete: ${artifactId}`);
		}
		const representation = descriptor.representations.find((candidate) => candidate.role === role);
		if (!representation) {
			throw new Error(`artifact representation not found: ${artifactId}/${role}`);
		}
		const bytes = readFileSync(join(artifactRoot, representation.path));
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (bytes.byteLength !== representation.byteSize || digest !== representation.checksum.digest) {
			throw new Error(`artifact representation checksum mismatch: ${artifactId}/${role}`);
		}
		return { ...representation, bytes };
	}

	return {
		initializeRun(input) {
		requirePathSafeId("runId", input.runId);
		const unitIds = new Set<string>();
		for (const unit of input.units) {
			requirePathSafeId("unitId", unit.unitId);
			if (unitIds.has(unit.unitId)) {
				throw new Error(`duplicate run observation unitId: ${unit.unitId}`);
			}
			unitIds.add(unit.unitId);
		}
			const snapshot: RunObservationSnapshot = {
				schemaVersion: 1,
				runId: input.runId,
				experimentId: input.experimentId,
				procedureSpecId: input.procedureSpecId,
				throughSequence: 0,
				status: "queued",
				progress: {
					completedUnits: 0,
					failedUnits: 0,
					totalUnits: input.units.length,
				},
				units: input.units.map((unit) => ({
					...unit,
					status: "pending",
					attemptCount: 0,
					canonicalArtifactIds: [],
				})),
				startedAt: input.startedAt,
				updatedAt: input.startedAt,
			};
			writeJsonFileAtomic(runObservationPath(cwd, input.runId), snapshot);
			return snapshot;
		},
		applyRunChange(runId, change) {
			const current = readJsonFile<RunObservationSnapshot>(runObservationPath(cwd, runId));
			if (!current) {
				throw new Error(`run observation not found: ${runId}`);
			}
			if ("unitId" in change) {
				requirePathSafeId("unitId", change.unitId);
				requirePathSafeId("attemptId", change.attemptId);
				const unit = current.units.find((candidate) => candidate.unitId === change.unitId);
				if (!unit) {
					throw new Error(`run observation unit not found: ${change.unitId}`);
				}
				if (change.type === "attempt_started") {
					const alreadyUsed = readJsonLines<RunObservationEvent>(runObservationEventsPath(cwd, runId)).some(
						(event) => event.change.type === "attempt_started" &&
							event.change.unitId === change.unitId && event.change.attemptId === change.attemptId,
					);
					if (alreadyUsed) {
						throw new Error(`attemptId was already used for unit ${change.unitId}: ${change.attemptId}`);
					}
					if (unit.activeAttemptId !== undefined || unit.status === "succeeded") {
						throw new Error(`unit cannot start attempt from status ${unit.status}: ${change.unitId}`);
					}
				} else if (unit.activeAttemptId !== change.attemptId) {
					throw new Error(`attempt is not active for unit ${change.unitId}: ${change.attemptId}`);
				}
			}
			const sequence = current.throughSequence + 1;
			let next: RunObservationSnapshot;
			if (change.type === "run_started") {
				next = {
					...current,
					throughSequence: sequence,
					status: "running",
					updatedAt: change.timestamp,
				};
			} else if (change.type === "run_paused") {
				next = { ...current, throughSequence: sequence, status: "paused", updatedAt: change.timestamp };
			} else if (change.type === "run_aborted") {
				next = {
					...current,
					throughSequence: sequence,
					status: "aborted",
					units: current.units.map((unit) =>
						unit.status === "pending" || unit.status === "waiting_retry"
							? { ...unit, status: "cancelled", endedAt: change.timestamp }
							: unit,
					),
					updatedAt: change.timestamp,
					endedAt: change.timestamp,
				};
			} else if (change.type === "run_failed") {
				next = { ...current, throughSequence: sequence, status: "failed", updatedAt: change.timestamp, endedAt: change.timestamp };
			} else if (change.type === "run_completed") {
				next = {
					...current,
					throughSequence: sequence,
					status: "completed",
					units: current.units.map((unit) =>
						unit.status === "pending" || unit.status === "waiting_retry"
							? { ...unit, status: "cancelled", endedAt: change.timestamp }
							: unit,
					),
					updatedAt: change.timestamp,
					endedAt: change.timestamp,
				};
			} else if (change.type === "attempt_started") {
				next = {
					...current,
					throughSequence: sequence,
					units: updateUnit(current, change.unitId, (unit) => ({
						...unit,
						status: "running",
						activeAttemptId: change.attemptId,
						attemptCount: unit.attemptCount + 1,
						startedAt: unit.startedAt ?? change.timestamp,
					})),
					updatedAt: change.timestamp,
				};
			} else if (change.type === "attempt_failed") {
				next = {
					...current,
					throughSequence: sequence,
					progress: change.willRetry
						? current.progress
						: { ...current.progress, failedUnits: current.progress.failedUnits + 1 },
					units: updateUnit(current, change.unitId, (unit) => ({
						...unit,
						status: change.willRetry ? "waiting_retry" : "failed",
						activeAttemptId: undefined,
						endedAt: change.willRetry ? undefined : change.timestamp,
					})),
					updatedAt: change.timestamp,
				};
			} else if (change.type === "attempt_accepted") {
				next = {
					...current,
					throughSequence: sequence,
					progress: { ...current.progress, completedUnits: current.progress.completedUnits + 1 },
					units: updateUnit(current, change.unitId, (unit) => ({
						...unit,
						status: "succeeded",
						activeAttemptId: undefined,
						acceptedAttemptId: change.attemptId,
						canonicalArtifactIds: change.canonicalArtifactIds,
						endedAt: change.timestamp,
					})),
					updatedAt: change.timestamp,
				};
			} else {
				next = {
					...current,
					throughSequence: sequence,
					updatedAt: change.timestamp,
				};
			}
			const event: RunObservationEvent = {
				schemaVersion: 1,
				sequence,
				eventId: `${runId}-event-${String(sequence).padStart(6, "0")}`,
				runId,
				timestamp: change.timestamp,
				change,
			};
			appendJsonLine(runObservationEventsPath(cwd, runId), event);
			writeJsonFileAtomic(runObservationPath(cwd, runId), next);
			return next;
		},
		readRun(runId) {
			return readJsonFile<RunObservationSnapshot>(runObservationPath(cwd, runId));
		},
		readEvents(runId, afterSequence) {
			return readJsonLines<RunObservationEvent>(runObservationEventsPath(cwd, runId)).filter(
				(event) => event.sequence > afterSequence,
			);
		},
		initializeOperatorOperation(input) {
			requirePathSafeId("operationId", input.operationId);
			writeJsonFileAtomic(operatorOperationPath(cwd, input.operationId), {
				schemaVersion: 1,
				...input,
			});
		},
		recoverInterruptedPublications(runId) {
			const unitsRoot = join(runRoot(cwd, runId), "artifacts", "units");
			if (!existsSync(unitsRoot)) {
				return [];
			}
			const recovered: ArtifactDescriptor[] = [];
			const indexedArtifactIds = new Set(
				(readJsonFile<ArtifactIndex>(runArtifactIndexPath(cwd, runId))?.artifacts ?? []).map((entry) => entry.artifactId),
			);
			for (const unitEntry of readdirSync(unitsRoot, { withFileTypes: true })) {
				if (!unitEntry.isDirectory()) continue;
				const attemptsRoot = join(unitsRoot, unitEntry.name, "attempts");
				if (!existsSync(attemptsRoot)) continue;
				for (const attemptEntry of readdirSync(attemptsRoot, { withFileTypes: true })) {
					if (!attemptEntry.isDirectory()) continue;
					const attemptRoot = join(attemptsRoot, attemptEntry.name);
					for (const artifactEntry of readdirSync(attemptRoot, { withFileTypes: true })) {
						if (!artifactEntry.isDirectory() || artifactEntry.name.endsWith(".recovery")) continue;
						const interruptedRoot = join(attemptRoot, artifactEntry.name);
						let intent: ArtifactPublicationIntent | undefined;
						if (artifactEntry.name.endsWith(".staging")) {
							intent = readJsonFile<ArtifactPublicationIntent>(join(interruptedRoot, "publication.json"));
						} else if (!indexedArtifactIds.has(artifactEntry.name)) {
							const unindexed = readJsonFile<ArtifactDescriptor>(join(interruptedRoot, "descriptor.json"));
							if (unindexed) {
								intent = {
									schemaVersion: 1,
									artifactId: unindexed.artifactId,
									scope: unindexed.scope,
									layer: unindexed.layer,
									profile: unindexed.profile,
									sourceArtifactIds: unindexed.sourceArtifactIds,
									createdAt: unindexed.createdAt,
									data: unindexed.data,
								};
							}
						} else {
							continue;
						}
						if (!intent || intent.scope.kind !== "run" || intent.scope.runId !== runId) continue;
						const finalRoot = runArtifactRoot(cwd, runId, intent.scope.unitId, intent.scope.attemptId, intent.artifactId);
						const recoveryRoot = `${finalRoot}.recovery`;
						rmSync(recoveryRoot, { recursive: true, force: true });
						renameSync(interruptedRoot, recoveryRoot);
						const descriptor: ArtifactDescriptor = {
							schemaVersion: 1,
							artifactId: intent.artifactId,
							scope: intent.scope,
							layer: intent.layer,
							profile: intent.profile,
							status: "failed",
							sourceArtifactIds: intent.sourceArtifactIds,
							data: intent.data,
							representations: [],
							createdAt: intent.createdAt,
							error: {
								errorCode: "publication_interrupted",
								message: `artifact publication was interrupted; staging retained at ${relative(runRoot(cwd, runId), recoveryRoot)}`,
							},
						};
						writeJsonFileAtomic(join(finalRoot, "descriptor.json"), descriptor);
						const throughSequence = this.applyRunChange(runId, {
							type: "artifact_status_changed",
							artifactId: descriptor.artifactId,
							status: "failed",
							timestamp: descriptor.createdAt,
						}).throughSequence;
						const indexPath = runArtifactIndexPath(cwd, runId);
						const currentIndex = readJsonFile<ArtifactIndex>(indexPath) ?? {
							schemaVersion: 1,
							scopeId: runId,
							throughSequence: 0,
							artifacts: [],
						};
						writeJsonFileAtomic(indexPath, {
							...currentIndex,
							throughSequence,
							artifacts: currentIndex.artifacts.concat({
								artifactId: descriptor.artifactId,
								layer: descriptor.layer,
								profile: descriptor.profile,
								status: "failed",
								unitId: intent.scope.unitId,
								attemptId: intent.scope.attemptId,
								descriptorPath: relative(runRoot(cwd, runId), join(finalRoot, "descriptor.json")).replace(/\\/gu, "/"),
							}),
						});
						recovered.push(descriptor);
						indexedArtifactIds.add(descriptor.artifactId);
					}
				}
			}
			return recovered;
		},
		publishArtifact(input) {
			const { scope } = input;
			const identifiers = scope.kind === "run"
				? { runId: scope.runId, unitId: scope.unitId, attemptId: scope.attemptId, actionId: scope.actionId, artifactId: input.artifactId }
				: { operationId: scope.operationId, actionId: scope.actionId, artifactId: input.artifactId };
			for (const [label, value] of Object.entries(identifiers)) {
				requirePathSafeId(label, value);
			}
			if (scope.kind === "run") {
				const run = readJsonFile<RunObservationSnapshot>(runObservationPath(cwd, scope.runId));
				if (!run) {
					throw new Error(`run observation not found: ${scope.runId}`);
				}
				const unit = run.units.find((candidate) => candidate.unitId === scope.unitId);
				if (!unit) {
					throw new Error(`run observation unit not found: ${scope.unitId}`);
				}
				if (unit.activeAttemptId !== scope.attemptId) {
					throw new Error(`artifact attempt is not active for unit ${scope.unitId}: ${scope.attemptId}`);
				}
			}
			if (scope.kind === "operator" && !readJsonFile(operatorOperationPath(cwd, scope.operationId))) {
				throw new Error(`operator operation not found: ${scope.operationId}`);
			}
			const finalRoot = scope.kind === "run"
				? runArtifactRoot(cwd, scope.runId, scope.unitId, scope.attemptId, input.artifactId)
				: operatorArtifactRoot(cwd, scope.operationId, input.artifactId);
			if (existsSync(finalRoot)) {
				throw new Error(`artifact already exists: ${input.artifactId}`);
			}
			const stagingRoot = `${finalRoot}.staging`;
			rmSync(stagingRoot, { recursive: true, force: true });
			const intent: ArtifactPublicationIntent = {
				schemaVersion: 1,
				artifactId: input.artifactId,
				scope,
				layer: input.layer,
				profile: input.profile,
				sourceArtifactIds: input.sourceArtifactIds,
				createdAt: input.createdAt,
				data: "descriptorData" in input ? input.descriptorData : undefined,
			};
			writeJsonFileAtomic(join(stagingRoot, "publication.json"), intent);
			if (scope.kind === "run") {
				this.applyRunChange(scope.runId, {
					type: "artifact_status_changed",
					artifactId: input.artifactId,
					status: "pending",
					timestamp: input.createdAt,
				});
				this.applyRunChange(scope.runId, {
					type: "artifact_status_changed",
					artifactId: input.artifactId,
					status: "producing",
					timestamp: input.createdAt,
				});
			}
			let descriptor: ArtifactDescriptor;
			try {
				if (scope.kind === "run" && input.layer === "canonical") {
					if (input.sourceArtifactIds.length === 0) {
						throw new Error(`canonical artifact requires source provenance: ${input.artifactId}`);
					}
					for (const sourceArtifactId of input.sourceArtifactIds) {
						const source = this.readArtifact(scope.runId, sourceArtifactId);
						if (
							!source || source.status !== "complete" || source.scope.kind !== "run" ||
							source.scope.unitId !== scope.unitId || source.scope.attemptId !== scope.attemptId
						) {
							throw new Error(`canonical source artifact must be complete in the same attempt: ${sourceArtifactId}`);
						}
					}
				}
				const candidates = input.canonicalData !== undefined
					? canonicalRepresentationCandidates(input)
					: input.representations;
				if (input.canonicalData === undefined) {
					validateFrameCandidates(input, candidates);
				}
				const representations = candidates.map((candidate) => {
					requirePathSafeId("representation fileName", candidate.fileName);
					if (candidate.sourcePath !== undefined && !existsSync(candidate.sourcePath)) {
						throw new Error(`artifact source does not exist: ${candidate.sourcePath}`);
					}
					const representationPath = join(stagingRoot, "representations", candidate.fileName);
					mkdirSync(dirname(representationPath), { recursive: true });
					if (candidate.sourcePath !== undefined) {
						copyFileSync(candidate.sourcePath, representationPath);
					} else if (candidate.content !== undefined) {
						writeFileSync(representationPath, candidate.content);
					} else {
						throw new Error(`artifact representation has no content: ${candidate.fileName}`);
					}
					return {
						role: candidate.role,
						mediaType: candidate.mediaType,
						path: `representations/${candidate.fileName}`,
						byteSize: statSync(representationPath).size,
						checksum: { algorithm: "sha256" as const, digest: sha256(representationPath) },
					};
				});
				descriptor = {
					schemaVersion: 1,
					artifactId: input.artifactId,
					scope,
					layer: input.layer,
					profile: input.profile,
					status: "complete",
					sourceArtifactIds: input.sourceArtifactIds,
					data: "descriptorData" in input ? input.descriptorData : undefined,
					representations,
					createdAt: input.createdAt,
					completedAt: input.createdAt,
				};
				writeJsonFileAtomic(join(stagingRoot, "descriptor.json"), descriptor);
				rmSync(join(stagingRoot, "publication.json"));
				mkdirSync(dirname(finalRoot), { recursive: true });
				renameSync(stagingRoot, finalRoot);
			} catch (cause) {
				rmSync(stagingRoot, { recursive: true, force: true });
				descriptor = {
					schemaVersion: 1,
					artifactId: input.artifactId,
					scope,
					layer: input.layer,
					profile: input.profile,
					status: "failed",
					sourceArtifactIds: input.sourceArtifactIds,
					data: "descriptorData" in input ? input.descriptorData : undefined,
					representations: [],
					createdAt: input.createdAt,
					error: {
						errorCode: cause instanceof Error && cause.message.startsWith("artifact source does not exist:")
							? "artifact_source_missing"
							: "artifact_publication_failed",
						message: cause instanceof Error ? cause.message : String(cause),
					},
				};
				writeJsonFileAtomic(join(finalRoot, "descriptor.json"), descriptor);
			}

			const throughSequence = scope.kind === "run"
				? this.applyRunChange(scope.runId, {
						type: "artifact_status_changed",
						artifactId: input.artifactId,
						status: descriptor.status,
						timestamp: input.createdAt,
					}).throughSequence
				: 0;
			const root = scope.kind === "run" ? runRoot(cwd, scope.runId) : operatorOperationRoot(cwd, scope.operationId);
			const descriptorPath = relative(root, join(finalRoot, "descriptor.json")).replace(/\\/gu, "/");
			const indexPath = scope.kind === "run"
				? runArtifactIndexPath(cwd, scope.runId)
				: operatorArtifactIndexPath(cwd, scope.operationId);
			const currentIndex = readJsonFile<ArtifactIndex>(indexPath) ?? {
				schemaVersion: 1,
				scopeId: scope.kind === "run" ? scope.runId : scope.operationId,
				throughSequence: 0,
				artifacts: [],
			};
			const entry: ArtifactIndexEntry = {
				artifactId: input.artifactId,
				layer: input.layer,
				profile: input.profile,
				status: descriptor.status,
				unitId: scope.kind === "run" ? scope.unitId : undefined,
				attemptId: scope.kind === "run" ? scope.attemptId : undefined,
				descriptorPath,
			};
			writeJsonFileAtomic(indexPath, {
				...currentIndex,
				throughSequence,
				artifacts: currentIndex.artifacts.concat(entry),
			});
			return descriptor;
		},
		listArtifacts(runId, filter) {
			return listIndexedArtifacts(runArtifactIndexPath(cwd, runId), runRoot(cwd, runId), filter);
		},
		readArtifact(runId, artifactId) {
			return this.listArtifacts(runId).find((artifact) => artifact.artifactId === artifactId);
		},
		listOperatorArtifacts(operationId) {
			return listIndexedArtifacts(operatorArtifactIndexPath(cwd, operationId), operatorOperationRoot(cwd, operationId));
		},
		readOperatorArtifact(operationId, artifactId) {
			return this.listOperatorArtifacts(operationId).find((artifact) => artifact.artifactId === artifactId);
		},
		readRepresentation(runId, artifactId, role) {
			const descriptor = this.readArtifact(runId, artifactId);
			if (descriptor?.scope.kind === "operator") {
				throw new Error(`run artifact has invalid operator scope: ${artifactId}`);
			}
			const artifactRoot = runArtifactRoot(
				cwd,
				runId,
				descriptor?.scope.unitId ?? "",
				descriptor?.scope.attemptId ?? "",
				artifactId,
			);
			return readCompleteRepresentation(descriptor, artifactRoot, artifactId, role);
		},
		readOperatorRepresentation(operationId, artifactId, role) {
			const descriptor = this.readOperatorArtifact(operationId, artifactId);
			if (descriptor?.scope.kind === "run") {
				throw new Error(`operator artifact has invalid run scope: ${artifactId}`);
			}
			return readCompleteRepresentation(
				descriptor,
				operatorArtifactRoot(cwd, operationId, artifactId),
				artifactId,
				role,
			);
		},
	};
}

export function recoverWorkspaceInterruptedPublications(cwd: string): ArtifactDescriptor[] {
	const root = runsRoot(cwd);
	if (!existsSync(root)) {
		return [];
	}
	const records = createRunRecords(cwd);
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() && readJsonFile<RunObservationSnapshot>(runObservationPath(cwd, entry.name))
			? records.recoverInterruptedPublications(entry.name)
			: [],
	);
}
