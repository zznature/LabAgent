import { Type, type Static } from "typebox";
import { runEventsPath } from "./layout.ts";
import { appendJsonLine, readJsonLines } from "./storage.ts";
import { compileSchema } from "../schemas/validation.ts";

export const RunEventSchema = Type.Object(
	{
		eventId: Type.String({ minLength: 1 }),
		runId: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		eventType: Type.String({ minLength: 1 }),
		timestamp: Type.String({ minLength: 1 }),
		payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export type RunEvent = Static<typeof RunEventSchema>;

export const RunEventValidator = compileSchema(RunEventSchema);

export function appendRunEvent(cwd: string, event: RunEvent): string {
	const path = runEventsPath(cwd, event.runId);
	appendJsonLine(path, event);
	return path;
}

export function readRunEvents(cwd: string, runId: string): RunEvent[] {
	return readJsonLines<RunEvent>(runEventsPath(cwd, runId));
}
