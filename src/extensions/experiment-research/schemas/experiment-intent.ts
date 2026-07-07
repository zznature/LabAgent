import { Type, type Static } from "typebox";
import { compileSchema } from "./validation.ts";

export const ExperimentIntentSchema = Type.Object(
	{
		intentId: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		objective: Type.String({ minLength: 1 }),
		hypothesis: Type.Optional(Type.String({ minLength: 1 })),
		question: Type.Optional(Type.String({ minLength: 1 })),
		constraints: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		successCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		notes: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type ExperimentIntent = Static<typeof ExperimentIntentSchema>;

export const ExperimentIntentValidator = compileSchema(ExperimentIntentSchema);
