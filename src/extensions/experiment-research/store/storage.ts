import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureParentDirectory(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

export function writeJsonFile(path: string, value: unknown): void {
	ensureParentDirectory(path);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function writeNewJsonFile(path: string, value: unknown): void {
	if (existsSync(path)) {
		throw new Error(`record already exists: ${path}`);
	}
	writeJsonFile(path, value);
}

export function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function appendJsonLine(path: string, value: unknown): void {
	ensureParentDirectory(path);
	writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf-8", flag: "a" });
}

export function readJsonLines<T>(path: string): T[] {
	if (!existsSync(path)) {
		return [];
	}
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

export function listJsonFiles(path: string): string[] {
	if (!existsSync(path)) {
		return [];
	}
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

export function listDirectories(path: string): string[] {
	if (!existsSync(path)) {
		return [];
	}
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}
