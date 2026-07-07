import type { RunState } from "../schemas/run-state.ts";
import { runsRoot, runStatePath } from "./layout.ts";
import { listDirectories, readJsonFile, writeJsonFile } from "./storage.ts";

export interface StoredRunStateRef {
	runId: string;
	path: string;
}

export function writeRunStateSnapshot(cwd: string, runState: RunState): StoredRunStateRef {
	const path = runStatePath(cwd, runState.runId);
	writeJsonFile(path, runState);
	return {
		runId: runState.runId,
		path,
	};
}

export function readRunStateSnapshot(cwd: string, runId: string): RunState | undefined {
	return readJsonFile<RunState>(runStatePath(cwd, runId));
}

export function listRunStateSnapshots(cwd: string, experimentId?: string): RunState[] {
	return listDirectories(runsRoot(cwd))
		.map((runId) => readRunStateSnapshot(cwd, runId))
		.filter((runState): runState is RunState => {
			if (!runState) {
				return false;
			}
			if (!experimentId) {
				return true;
			}
			return runState.experimentId === experimentId;
		});
}
