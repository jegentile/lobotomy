/**
 * Continue CLI (`cn`, docs.continue.dev): `~/.continue/config.yaml` only. The
 * agent uses the first model listed with the `chat` role; `edit` and `apply`
 * roles cover edits; `subagent` needs a system message. Compaction reuses the
 * chat model, so `compact` does not apply.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, type YAMLMap, YAMLSeq } from "yaml";

import { isRouted, routeFor } from "../tasks.ts";
import { readYaml, translateProvider, writeYaml } from "./common.ts";
import type { Adapter } from "./types.ts";

const NAME = "continue";
const RENAMES: Record<string, string> = { google: "gemini" };
const SUBAGENT_PROMPT = "You are a focused subagent. Complete the delegated task and report the result concisely.";

export const continueCli: Adapter = {
	name: NAME,
	description: "Continue CLI (cn): models list with chat, edit/apply and subagent roles",
	tasks: ["main", "edit", "subagent"],
	modelHint: "Continue provider and model, e.g. anthropic/claude-sonnet-4-6, openai/gpt-4o, gemini/gemini-2.5-pro",
	target: () => join(homedir(), ".continue", "config.yaml"),
	formatModel: (route) => (route.model ? translateProvider(route.model, RENAMES).ref : "inherit"),
	write(config, { dryRun, project }) {
		const path = continueCli.target(process.cwd());
		const doc = readYaml(path);
		const changes: string[] = [];
		const notes: string[] = [];
		if (project) notes.push("cn reads only ~/.continue/config.yaml; wrote the user file");
		if (doc.get("name") === undefined) doc.set("name", "Lobotomy routes");
		if (doc.get("version") === undefined) doc.set("version", "1.0.0");
		if (doc.get("schema") === undefined) doc.set("schema", "v1");
		let models = doc.get("models");
		if (!isSeq(models)) {
			models = new YAMLSeq();
			doc.set("models", models);
		}
		const list = models as YAMLSeq;

		const entryFor = (provider: string, id: string): YAMLMap => {
			for (const item of list.items) {
				if (isMap(item) && item.get("provider") === provider && item.get("model") === id) return item;
			}
			const created = doc.createNode({ name: `${id} (${provider})`, provider, model: id, roles: [] }) as YAMLMap;
			list.add(created);
			return created;
		};
		const rolesOf = (entry: YAMLMap): string[] | undefined => {
			const current = entry.get("roles");
			if (isSeq(current)) return current.items.map((r) => String(r));
			if (Array.isArray(current)) return current.map((r) => String(r));
			return undefined;
		};
		const addRoles = (entry: YAMLMap, roles: string[]) => {
			entry.set("roles", doc.createNode([...new Set([...(rolesOf(entry) ?? []), ...roles])]));
		};
		const removeRole = (role: string, except: YAMLMap) => {
			for (const item of list.items) {
				if (!isMap(item) || item === except) continue;
				const have = rolesOf(item);
				if (!have) continue;
				item.set("roles", doc.createNode(have.filter((r) => r !== role)));
			}
		};

		const main = routeFor(config, NAME, "main");
		if (main && isRouted(main.model)) {
			const { provider, id } = translateProvider(main.model, RENAMES);
			if (!provider) notes.push(`main: "${main.model}" has no provider`);
			else {
				const entry = entryFor(provider, id);
				addRoles(entry, ["chat"]);
				// cn takes the first chat-role model, so move this one to the front.
				const index = list.items.indexOf(entry);
				if (index > 0) {
					list.items.splice(index, 1);
					list.items.unshift(entry);
				}
				changes.push(`models[0] = ${provider}/${id} with role chat (main)`);
				notes.push("cn remembers the model you last picked with /model; pick this one once if another is remembered");
			}
		}
		const edit = routeFor(config, NAME, "edit");
		if (edit && isRouted(edit.model)) {
			const { provider, id } = translateProvider(edit.model, RENAMES);
			if (!provider) notes.push(`edit: "${edit.model}" has no provider`);
			else {
				const entry = entryFor(provider, id);
				addRoles(entry, ["edit", "apply"]);
				removeRole("edit", entry);
				removeRole("apply", entry);
				changes.push(`${provider}/${id}: roles edit, apply (edit)`);
			}
		}
		const sub = routeFor(config, NAME, "subagent");
		if (sub && isRouted(sub.model)) {
			const { provider, id } = translateProvider(sub.model, RENAMES);
			if (!provider) notes.push(`subagent: "${sub.model}" has no provider`);
			else {
				const entry = entryFor(provider, id);
				addRoles(entry, ["subagent"]);
				if (!isMap(entry.get("chatOptions"))) entry.set("chatOptions", { baseSystemMessage: SUBAGENT_PROMPT });
				changes.push(`${provider}/${id}: role subagent (subagent)`);
			}
		}
		if (changes.length > 0) notes.push("each model entry needs the provider's API key (apiKey or ${{ secrets.NAME }}) to be usable");
		if (!dryRun && changes.length > 0) writeYaml(path, doc);
		return { path, changes, notes };
	},
};
