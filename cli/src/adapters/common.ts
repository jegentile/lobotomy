import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Document, parseDocument } from "yaml";

import { type Level, parseModelRef } from "../tasks.ts";

/** Reads a YAML file as a document that keeps comments, or an empty one. */
export function readYaml(path: string): Document {
	if (!existsSync(path)) return new Document({});
	const doc = parseDocument(readFileSync(path, "utf-8"));
	if (doc.errors.length > 0) throw new Error(`${path}: ${doc.errors[0]?.message ?? "invalid YAML"}`);
	return doc;
}

export function writeYaml(path: string, doc: Document): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, doc.toString(), "utf-8");
}

/** The three-step effort most agents accept. */
export function threeLevels(level: Level | undefined): "low" | "medium" | "high" | undefined {
	if (!level) return undefined;
	return level === "max" ? "high" : level;
}

/** `provider/model` with the provider renamed to the agent's own id. */
export function translateProvider(model: string, renames: Record<string, string>): { provider?: string; id: string; ref: string } {
	const { provider, id } = parseModelRef(model);
	const named = provider ? (renames[provider] ?? provider) : undefined;
	return { provider: named, id, ref: named ? `${named}/${id}` : id };
}
