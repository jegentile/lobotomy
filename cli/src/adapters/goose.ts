/**
 * Goose (block.github.io/goose): `~/.config/goose/config.yaml`. Goose keeps
 * one active provider and model, plus a separate provider and model for
 * subagents; its planner and lead/worker modes were removed, so only `main`
 * and `subagent` apply. No project-level file exists.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { isRouted, routeFor } from "../tasks.ts";
import { readYaml, translateProvider, writeYaml } from "./common.ts";
import type { Adapter } from "./types.ts";

const NAME = "goose";
const RENAMES: Record<string, string> = { google: "google", gemini: "google", "openai": "openai" };

export const goose: Adapter = {
	name: NAME,
	description: "block.github.io/goose: active provider/model and the subagent model",
	tasks: ["main", "subagent"],
	modelHint: "goose provider id and the provider's raw model id, e.g. anthropic/claude-sonnet-4-5-20250929",
	target: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "goose", "config.yaml"),
	formatModel: (route) => (route.model ? translateProvider(route.model, RENAMES).ref : "inherit"),
	write(config, { dryRun, project }) {
		const path = goose.target(process.cwd());
		const changes: string[] = [];
		const notes: string[] = [];
		if (project) notes.push("goose has no project config; wrote the user file");
		const doc = readYaml(path);
		const main = routeFor(config, NAME, "main");
		if (main && isRouted(main.model)) {
			const { provider, id } = translateProvider(main.model, RENAMES);
			if (!provider) notes.push(`main: "${main.model}" has no provider; goose needs provider/model`);
			else {
				doc.setIn(["active_provider"], provider);
				doc.setIn(["providers", provider, "model"], id);
				if (doc.getIn(["providers", provider, "enabled"]) === undefined) doc.setIn(["providers", provider, "enabled"], true);
				if (doc.getIn(["providers", provider, "configured"]) === undefined) doc.setIn(["providers", provider, "configured"], true);
				// Legacy flat keys would be migrated over the new block; drop them.
				doc.deleteIn(["GOOSE_PROVIDER"]);
				doc.deleteIn(["GOOSE_MODEL"]);
				changes.push(`active_provider = ${provider}, providers.${provider}.model = ${id}`);
			}
			if (main.level) notes.push("goose has no documented effort setting; the main level was not written");
		}
		const sub = routeFor(config, NAME, "subagent");
		if (sub && isRouted(sub.model)) {
			const { provider, id } = translateProvider(sub.model, RENAMES);
			if (!provider) notes.push(`subagent: "${sub.model}" has no provider; goose needs provider/model`);
			else {
				doc.setIn(["GOOSE_SUBAGENT_PROVIDER"], provider);
				doc.setIn(["GOOSE_SUBAGENT_MODEL"], id);
				changes.push(`GOOSE_SUBAGENT_PROVIDER = ${provider}, GOOSE_SUBAGENT_MODEL = ${id}`);
			}
		}
		if (changes.length > 0) notes.push("GOOSE_PROVIDER / GOOSE_MODEL environment variables still win over the file; a provider needs its API key configured in goose");
		if (!dryRun && changes.length > 0) writeYaml(path, doc);
		return { path, changes, notes };
	},
};
