import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";

export function compileSchema<T extends TSchema>(schema: T): Validator<{}, T> {
	return Compile(schema);
}

export function formatValidationErrors<T extends TSchema>(validator: Validator<{}, T>, value: unknown): string[] {
	return Array.from(validator.Errors(value)).map((error) => `${error.instancePath || "/"}: ${error.message}`);
}
