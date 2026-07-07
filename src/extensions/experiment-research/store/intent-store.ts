import type { ExperimentIntent } from "../schemas/experiment-intent.ts";
import { experimentRoot, intentPath, intentsRoot } from "./layout.ts";
import { listJsonFiles, readJsonFile, writeNewJsonFile } from "./storage.ts";

export interface StoredIntentRef {
	experimentId: string;
	intentId: string;
	path: string;
}

export function saveExperimentIntent(cwd: string, intent: ExperimentIntent): StoredIntentRef {
	const path = intentPath(cwd, intent.experimentId, intent.intentId);
	writeNewJsonFile(path, intent);
	return {
		experimentId: intent.experimentId,
		intentId: intent.intentId,
		path,
	};
}

export function readExperimentIntent(cwd: string, experimentId: string, intentId: string): ExperimentIntent | undefined {
	return readJsonFile<ExperimentIntent>(intentPath(cwd, experimentId, intentId));
}

export function listExperimentIntents(cwd: string, experimentId: string): ExperimentIntent[] {
	const root = intentsRoot(cwd, experimentId);
	return listJsonFiles(root)
		.map((fileName) => readJsonFile<ExperimentIntent>(intentPath(cwd, experimentId, fileName.replace(/\.json$/u, ""))))
		.filter((intent): intent is ExperimentIntent => intent !== undefined);
}

export function getExperimentIntentDirectory(cwd: string, experimentId: string): string {
	return experimentRoot(cwd, experimentId);
}
