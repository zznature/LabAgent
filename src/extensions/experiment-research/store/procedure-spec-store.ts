import type { ProcedureSpec } from "../schemas/procedure-spec.ts";
import { procedureSpecPath, procedureSpecsRoot } from "./layout.ts";
import { listJsonFiles, readJsonFile, writeNewJsonFile } from "./storage.ts";

export interface StoredProcedureSpecRef {
	experimentId: string;
	procedureSpecId: string;
	path: string;
}

export function saveFrozenProcedureSpec(cwd: string, spec: ProcedureSpec): StoredProcedureSpecRef {
	const path = procedureSpecPath(cwd, spec.experimentId, spec.procedureSpecId);
	writeNewJsonFile(path, spec);
	return {
		experimentId: spec.experimentId,
		procedureSpecId: spec.procedureSpecId,
		path,
	};
}

export function readProcedureSpec(cwd: string, experimentId: string, procedureSpecId: string): ProcedureSpec | undefined {
	return readJsonFile<ProcedureSpec>(procedureSpecPath(cwd, experimentId, procedureSpecId));
}

export function listProcedureSpecs(cwd: string, experimentId: string): ProcedureSpec[] {
	const root = procedureSpecsRoot(cwd, experimentId);
	return listJsonFiles(root)
		.map((fileName) =>
			readJsonFile<ProcedureSpec>(procedureSpecPath(cwd, experimentId, fileName.replace(/\.json$/u, ""))),
		)
		.filter((spec): spec is ProcedureSpec => spec !== undefined);
}
