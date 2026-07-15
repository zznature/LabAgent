import { join } from "node:path";

export function recordsRoot(cwd: string): string {
	return join(cwd, "lab-records");
}

export function labConfigRoot(cwd: string): string {
	return join(cwd, "lab-config");
}

export function experimentProcedureTemplatesRoot(cwd: string): string {
	return join(labConfigRoot(cwd), "templates");
}

export function experimentsRoot(cwd: string): string {
	return join(recordsRoot(cwd), "experiments");
}

export function experimentRoot(cwd: string, experimentId: string): string {
	return join(experimentsRoot(cwd), experimentId);
}

export function intentsRoot(cwd: string, experimentId: string): string {
	return join(experimentRoot(cwd, experimentId), "intents");
}

export function procedureSpecsRoot(cwd: string, experimentId: string): string {
	return join(experimentRoot(cwd, experimentId), "procedure-specs");
}

export function runsRoot(cwd: string): string {
	return join(recordsRoot(cwd), "runs");
}

export function operatorOperationsRoot(cwd: string): string {
	return join(recordsRoot(cwd), "operator-operations");
}

export function operatorOperationRoot(cwd: string, operationId: string): string {
	return join(operatorOperationsRoot(cwd), operationId);
}

export function operatorOperationPath(cwd: string, operationId: string): string {
	return join(operatorOperationRoot(cwd, operationId), "operation.json");
}

export function operatorArtifactIndexPath(cwd: string, operationId: string): string {
	return join(operatorOperationRoot(cwd, operationId), "artifact-index.json");
}

export function operatorArtifactRoot(cwd: string, operationId: string, artifactId: string): string {
	return join(operatorOperationRoot(cwd, operationId), "artifacts", artifactId);
}

export function runRoot(cwd: string, runId: string): string {
	return join(runsRoot(cwd), runId);
}

export function intentPath(cwd: string, experimentId: string, intentId: string): string {
	return join(intentsRoot(cwd, experimentId), `${intentId}.json`);
}

export function procedureSpecPath(cwd: string, experimentId: string, procedureSpecId: string): string {
	return join(procedureSpecsRoot(cwd, experimentId), `${procedureSpecId}.json`);
}

export function experimentProcedureTemplatePath(cwd: string, templateId: string): string {
	return join(experimentProcedureTemplatesRoot(cwd), `${templateId}.json`);
}

export function runStatePath(cwd: string, runId: string): string {
	return join(runRoot(cwd, runId), "run-state.json");
}

export function runObservationPath(cwd: string, runId: string): string {
	return join(runRoot(cwd, runId), "run-observation.json");
}

export function runEventsPath(cwd: string, runId: string): string {
	return join(runRoot(cwd, runId), "legacy-events.jsonl");
}

export function runObservationEventsPath(cwd: string, runId: string): string {
	return join(runRoot(cwd, runId), "events.jsonl");
}

export function runArtifactsPath(cwd: string, runId: string): string {
	return join(runRoot(cwd, runId), "artifacts.jsonl");
}

export function runArtifactIndexPath(cwd: string, runId: string): string {
	return join(runRoot(cwd, runId), "artifact-index.json");
}

export function runArtifactRoot(
	cwd: string,
	runId: string,
	unitId: string,
	attemptId: string,
	artifactId: string,
): string {
	return join(runRoot(cwd, runId), "artifacts", "units", unitId, "attempts", attemptId, artifactId);
}
