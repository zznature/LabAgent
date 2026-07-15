import {
	createRunRecords,
	type ArtifactDescriptor,
	type ArtifactFilter,
	type ReadRepresentationResult,
	type RunObservationEvent,
	type RunObservationSnapshot,
} from "./run-records.ts";

export interface RunRecordsReadAdapter {
	readRun(runId: string): RunObservationSnapshot | undefined;
	readEvents(runId: string, afterSequence: number): RunObservationEvent[];
	listArtifacts(runId: string, filter?: ArtifactFilter): ArtifactDescriptor[];
	readArtifact(runId: string, artifactId: string): ArtifactDescriptor | undefined;
	readRepresentation(runId: string, artifactId: string, role: string): ReadRepresentationResult;
	listOperatorArtifacts(operationId: string): ArtifactDescriptor[];
	readOperatorArtifact(operationId: string, artifactId: string): ArtifactDescriptor | undefined;
	readOperatorRepresentation(operationId: string, artifactId: string, role: string): ReadRepresentationResult;
}

export function createRunRecordsReadAdapter(cwd: string): RunRecordsReadAdapter {
	const records = createRunRecords(cwd);
	return {
		readRun: (runId) => records.readRun(runId),
		readEvents: (runId, afterSequence) => records.readEvents(runId, afterSequence),
		listArtifacts: (runId, filter) => records.listArtifacts(runId, filter),
		readArtifact: (runId, artifactId) => records.readArtifact(runId, artifactId),
		readRepresentation: (runId, artifactId, role) => records.readRepresentation(runId, artifactId, role),
		listOperatorArtifacts: (operationId) => records.listOperatorArtifacts(operationId),
		readOperatorArtifact: (operationId, artifactId) => records.readOperatorArtifact(operationId, artifactId),
		readOperatorRepresentation: (operationId, artifactId, role) =>
			records.readOperatorRepresentation(operationId, artifactId, role),
	};
}
