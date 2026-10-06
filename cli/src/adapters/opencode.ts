/**
 * OpenCode (opencode.ai): `opencode.json` in `~/.config/opencode/` or the
 * project root. Tasks map onto agents (`agent.<name>.model`), `small_model`
 * and the `/quick`, `/review`, `/commit` commands. Model ids are already
 * `provider/model`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { readJson, writeJson } from "../store.ts";
import { isRouted, type Route, routeFor } from "../tasks.ts";
import type { Adapter } from "./types.ts";

const NAME = "opencode";
const AGENTS_FOR_TASK: Record<string, string[]> = {
	main: ["build"],
	plan: ["plan"],
	subagent: ["general"],
	explore: ["explore"],
	compact: ["title", "summary", "compaction"],
};
const COMMANDS: Record<string, { task: string; description: string; template: string }> = {
	quick: { task: "quick", description: "Ask one question on the quick route", template: "Answer briefly and directly, without using tools unless essential:\n$ARGUMENTS" },
	review: {
		task: "review",
		description: "Review the working tree on the review route",
		template:
			"Review the current uncommitted changes (run `git status` and `git diff`). Report correctness bugs first, then risky changes, then smaller cleanups, each with file, line and a concrete failure scenario. Do not edit files.\nFocus: $ARGUMENTS",
	},
	commit: {
		task: "commit",
		description: "Commit the working tree on the commit route",
		template:
			"Commit the current changes: run `git status` and `git diff`, stage the relevant files, and write a clear commit message (imperative subject, blank line, a body explaining why). Do not push.\nGuidance: $ARGUMENTS",
	},
};

type OpencodeConfig = {
	$schema?: string;
	small_model?: string;
	agent?: Record<string, Record<string, unknown> | undefined>;
	command?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
};

export const opencode: Adapter = {
	name: NAME,
	description: "opencode.ai: agents build/plan/general/explore, small_model, commands",
	tasks: ["main", "plan", "quick", "review", "commit", "compact", "subagent", "explore"],
	modelHint: "provider/model as `opencode models` lists them, e.g. anthropic/claude-sonnet-4-5",
	target: (cwd) => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json"),
	formatModel: (route) => route.model ?? "inherit",
	write(config, { cwd, project, dryRun }) {
		const path = project ? join(cwd, "opencode.json") : opencode.target(cwd);
		const existing = (readJson(path) as OpencodeConfig | undefined) ?? { $schema: "https://opencode.ai/config.json" };
		const changes: string[] = [];
		const notes: string[] = [];
		const apply = (route: Route, target: Record<string, unknown>) => {
			if (isRouted(route.model)) target.model = route.model;
			if (route.level) target.variant = route.level;
		};
		existing.agent ??= {};
		for (const [task, agents] of Object.entries(AGENTS_FOR_TASK)) {
			const route = routeFor(config, NAME, task);
			if (!route) continue;
			for (const name of agents) {
				const agent = { ...(existing.agent[name] ?? {}) };
				apply(route, agent);
				existing.agent[name] = agent;
				changes.push(`agent.${name}.model = ${route.model ?? "(kept)"}${route.level ? `, variant = ${route.level}` : ""}`);
			}
		}
		const compact = routeFor(config, NAME, "compact");
		if (compact && isRouted(compact.model)) {
			existing.small_model = compact.model;
			changes.push(`small_model = ${compact.model}`);
		}
		existing.command ??= {};
		for (const [name, spec] of Object.entries(COMMANDS)) {
			const route = routeFor(config, NAME, spec.task);
			if (!route) continue;
			const current = existing.command[name];
			if (current && current.template !== spec.template) {
				notes.push(`command.${name} is yours; left alone (set its model to ${route.model ?? "the route's"} by hand)`);
				continue;
			}
			const command: Record<string, unknown> = { template: spec.template, description: spec.description };
			apply(route, command);
			existing.command[name] = command;
			changes.push(`command./${name} → ${route.model ?? "(default)"}${route.level ? ` @ ${route.level}` : ""}`);
		}
		if (Object.keys(existing.agent).length === 0) delete existing.agent;
		if (Object.keys(existing.command).length === 0) delete existing.command;
		if (route(config, "quick") === undefined) notes.push("OpenCode's `variant` field only applies to models that publish variants; others ignore the level");
		if (!dryRun && changes.length > 0) writeJson(path, existing);
		return { path, changes, notes };
	},
};

function route(config: Parameters<Adapter["write"]>[0], task: string) {
	return routeFor(config, NAME, task);
}
