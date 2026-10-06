/**
 * Crush (charmbracelet/crush): `crush.json` in `~/.config/crush/` or the
 * project root (strict JSON). Crush has two model slots: `large` runs the
 * agents, `small` writes titles. A `crushrc` script in the same place
 * overrides the JSON, so one is reported when present.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readJson, writeJson } from "../store.ts";
import { isRouted, type Route, routeFor } from "../tasks.ts";
import { threeLevels, translateProvider } from "./common.ts";
import type { Adapter } from "./types.ts";

const NAME = "crush";
const RENAMES: Record<string, string> = { google: "gemini" };

type CrushConfig = { $schema?: string; models?: Record<string, Record<string, unknown>>; [key: string]: unknown };

export const crush: Adapter = {
	name: NAME,
	description: "charm.land crush: models.large (main) and models.small (compact: titles)",
	tasks: ["main", "compact"],
	modelHint: "crush provider id and model id, e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o, gemini/gemini-2.5-pro",
	target: () => process.env.CRUSH_GLOBAL_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "crush", "crush.json"),
	formatModel: (route) => (route.model ? translateProvider(route.model, RENAMES).ref : "inherit"),
	write(config, { cwd, project, dryRun }) {
		const path = project ? join(cwd, "crush.json") : crush.target(cwd);
		const existing = (readJson(path) as CrushConfig | undefined) ?? { $schema: "https://charm.land/crush.json" };
		const changes: string[] = [];
		const notes: string[] = [];
		existing.models ??= {};
		const slot = (name: "large" | "small", task: string) => {
			const route: Route | undefined = routeFor(config, NAME, task);
			if (!route || !isRouted(route.model)) return;
			const { provider, id } = translateProvider(route.model, RENAMES);
			if (!provider) {
				notes.push(`${task}: "${route.model}" has no provider; crush needs provider/model`);
				return;
			}
			const current = { ...(existing.models?.[name] ?? {}) };
			current.provider = provider;
			current.model = id;
			const effort = threeLevels(route.level);
			if (effort) current.reasoning_effort = effort;
			else delete current.reasoning_effort;
			existing.models![name] = current;
			changes.push(`models.${name} = ${provider}/${id}${effort ? ` (reasoning_effort ${effort})` : ""} (${task})`);
		};
		slot("large", "main");
		slot("small", "compact");
		for (const rc of [".crushrc", "crushrc"]) {
			if (existsSync(join(dirname(path), rc))) notes.push(`${join(dirname(path), rc)} overrides crush.json; put the same \`model\` lines there`);
		}
		if (project) notes.push("crush walks up to the git root for crush.json; a .crushrc in the project also overrides it");
		if (!dryRun && changes.length > 0) writeJson(path, existing);
		return { path, changes, notes };
	},
};
