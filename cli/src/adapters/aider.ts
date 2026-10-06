/**
 * Aider (aider.chat): `.aider.conf.yml` in the home directory, or the git
 * root with `--project`. `model` is the main chat, `editor-model` applies
 * edits in architect mode, `weak-model` writes commit messages and chat
 * summaries. Model names are litellm style (`anthropic/claude-haiku-4-5`).
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { isRouted, routeFor } from "../tasks.ts";
import { readYaml, threeLevels, translateProvider, writeYaml } from "./common.ts";
import type { Adapter } from "./types.ts";

const NAME = "aider";
/** litellm's provider prefixes where they differ from the shared spelling. */
const RENAMES: Record<string, string> = { google: "gemini" };

export const aider: Adapter = {
	name: NAME,
	description: "aider.chat: model, editor-model (edit), weak-model (commit, compact), reasoning-effort",
	tasks: ["main", "edit", "commit", "compact"],
	modelHint: "litellm names, e.g. anthropic/claude-haiku-4-5, gemini/gemini-2.5-flash, openrouter/x/y",
	target: () => join(homedir(), ".aider.conf.yml"),
	formatModel: (route) => (route.model ? translateProvider(route.model, RENAMES).ref : "inherit"),
	write(config, { cwd, project, dryRun }) {
		const path = project ? join(cwd, ".aider.conf.yml") : aider.target(cwd);
		const doc = readYaml(path);
		const changes: string[] = [];
		const notes: string[] = [];
		const set = (key: string, task: string) => {
			const route = routeFor(config, NAME, task);
			if (!route || !isRouted(route.model)) return false;
			const { ref } = translateProvider(route.model, RENAMES);
			doc.setIn([key], ref);
			changes.push(`${key}: ${ref} (${task})`);
			return true;
		};
		set("model", "main");
		set("editor-model", "edit");
		if (!set("weak-model", "commit")) set("weak-model", "compact");
		const main = routeFor(config, NAME, "main");
		const effort = threeLevels(main?.level);
		if (effort) {
			doc.setIn(["reasoning-effort"], effort);
			changes.push(`reasoning-effort: ${effort} (main)`);
			notes.push("reasoning-effort only applies to models whose settings accept it (see aider's .aider.model.settings.yml)");
		}
		if (routeFor(config, NAME, "edit") && !doc.get("architect") && !doc.get("edit-format")) {
			notes.push("editor-model is used in architect mode; add `architect: true` to .aider.conf.yml or run aider --architect");
		}
		if (!dryRun && changes.length > 0) writeYaml(path, doc);
		return { path, changes, notes };
	},
};
