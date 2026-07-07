import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../schemas/tool-result.ts";
import { compileSchema } from "../schemas/validation.ts";
import { runArtifactsPath } from "./layout.ts";
import { appendJsonLine, readJsonLines } from "./storage.ts";

export const ArtifactRecordSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		recordedAt: Type.String({ minLength: 1 }),
		artifact: ArtifactRefSchema,
	},
	{ additionalProperties: false },
);

export type ArtifactRecord = Static<typeof ArtifactRecordSchema>;

export const ArtifactRecordValidator = compileSchema(ArtifactRecordSchema);

export function appendArtifactRecord(cwd: string, record: ArtifactRecord): string {
	const path = runArtifactsPath(cwd, record.runId);
	appendJsonLine(path, record);
	return path;
}

export function readArtifactRecords(cwd: string, runId: string): ArtifactRecord[] {
	return readJsonLines<ArtifactRecord>(runArtifactsPath(cwd, runId));
}
