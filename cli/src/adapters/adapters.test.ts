import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import type { Config } from "../tasks.ts";
import { aider } from "./aider.ts";
import { continueCli } from "./continue.ts";
import { crush } from "./crush.ts";
import { goose } from "./goose.ts";

const ROUTES: Config = {
	tasks: {
		main: { model: "anthropic/claude-sonnet-4-5", level: "max" },
		edit: { model: "anthropic/claude-haiku-4-5" },
		commit: { model: "google/gemini-2.5-flash" },
		compact: { model: "anthropic/claude-haiku-4-5" },
		subagent: { model: "openai/gpt-5-mini" },
	},
};

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "lobotomy-home-"));
	process.env.HOME = dir;
	process.env.XDG_CONFIG_HOME = join(dir, ".config");
	delete process.env.CRUSH_GLOBAL_CONFIG;
	return dir;
}

test("goose writes the provider block and the subagent keys, dropping legacy flat keys", () => {
	const dir = home();
	const path = join(dir, ".config", "goose", "config.yaml");
	mkdirSync(join(dir, ".config", "goose"), { recursive: true });
	writeFileSync(path, "# my goose config\nGOOSE_MODE: approve\nGOOSE_PROVIDER: openai\nGOOSE_MODEL: gpt-4o\nextensions:\n  developer:\n    enabled: true\n");
	const result = goose.write(ROUTES, { cwd: dir });
	assert.equal(result.path, path);
	const text = readFileSync(path, "utf-8");
	assert.match(text, /^# my goose config/);
	const written = parse(text);
	assert.equal(written.active_provider, "anthropic");
	assert.deepEqual(written.providers.anthropic, { model: "claude-sonnet-4-5", enabled: true, configured: true });
	assert.equal(written.GOOSE_PROVIDER, undefined);
	assert.equal(written.GOOSE_SUBAGENT_PROVIDER, "openai");
	assert.equal(written.GOOSE_SUBAGENT_MODEL, "gpt-5-mini");
	assert.equal(written.GOOSE_MODE, "approve");
	assert.deepEqual(written.extensions, { developer: { enabled: true } });
	assert.ok(result.notes.some((n) => n.includes("effort")));
});

test("aider writes model, editor-model, weak-model and reasoning-effort in litellm spelling", () => {
	const dir = home();
	const path = join(dir, ".aider.conf.yml");
	writeFileSync(path, "## keep\ndark-mode: true\n");
	const result = aider.write(ROUTES, { cwd: dir });
	assert.equal(result.path, path);
	const text = readFileSync(path, "utf-8");
	assert.match(text, /## keep/);
	const written = parse(text);
	assert.equal(written.model, "anthropic/claude-sonnet-4-5");
	assert.equal(written["editor-model"], "anthropic/claude-haiku-4-5");
	assert.equal(written["weak-model"], "gemini/gemini-2.5-flash");
	assert.equal(written["reasoning-effort"], "high");
	assert.equal(written["dark-mode"], true);
	assert.ok(result.notes.some((n) => n.includes("architect")));
	const project = aider.write({ tasks: { compact: { model: "anthropic/claude-haiku-4-5" } } }, { cwd: dir, project: true });
	assert.equal(project.path, join(dir, ".aider.conf.yml"));
	assert.equal(parse(readFileSync(project.path, "utf-8"))["weak-model"], "anthropic/claude-haiku-4-5");
});

test("continue puts the main model first with the chat role and assigns edit and subagent roles", () => {
	const dir = home();
	mkdirSync(join(dir, ".continue"), { recursive: true });
	const path = join(dir, ".continue", "config.yaml");
	writeFileSync(
		path,
		"name: mine\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: GPT\n    provider: openai\n    model: gpt-4o\n    roles: [chat, edit, apply]\n    apiKey: sk-x\n",
	);
	const result = continueCli.write(ROUTES, { cwd: dir });
	assert.equal(result.path, path);
	const written = parse(readFileSync(path, "utf-8"));
	assert.equal(written.name, "mine");
	assert.equal(written.models[0].provider, "anthropic");
	assert.equal(written.models[0].model, "claude-sonnet-4-5");
	assert.deepEqual(written.models[0].roles, ["chat"]);
	const gpt = written.models.find((m: { model: string }) => m.model === "gpt-4o");
	assert.deepEqual(gpt.roles, ["chat"], "edit and apply moved off the old entry");
	assert.equal(gpt.apiKey, "sk-x");
	const haiku = written.models.find((m: { model: string }) => m.model === "claude-haiku-4-5");
	assert.deepEqual(haiku.roles, ["edit", "apply"]);
	const sub = written.models.find((m: { model: string }) => m.model === "gpt-5-mini");
	assert.deepEqual(sub.roles, ["subagent"]);
	assert.ok(sub.chatOptions.baseSystemMessage);
});

test("crush writes large and small with reasoning effort, and warns about crushrc", () => {
	const dir = home();
	const configDir = join(dir, ".config", "crush");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "crush.json"), JSON.stringify({ $schema: "https://charm.land/crush.json", models: { large: { provider: "openai", model: "gpt-4o", max_tokens: 4096 } }, options: { debug: true } }));
	writeFileSync(join(configDir, "crushrc"), "model large openai/gpt-4o\n");
	const result = crush.write(ROUTES, { cwd: dir });
	assert.equal(result.path, join(configDir, "crush.json"));
	const written = JSON.parse(readFileSync(result.path, "utf-8"));
	assert.deepEqual(written.models.large, { provider: "anthropic", model: "claude-sonnet-4-5", max_tokens: 4096, reasoning_effort: "high" });
	assert.deepEqual(written.models.small, { provider: "anthropic", model: "claude-haiku-4-5" });
	assert.deepEqual(written.options, { debug: true });
	assert.ok(result.notes.some((n) => n.includes("crushrc")));
});

test("adapters do nothing on dry run or with no routes", () => {
	const dir = home();
	for (const adapter of [goose, aider, continueCli, crush]) {
		const empty = adapter.write({ tasks: {} }, { cwd: dir });
		assert.deepEqual(empty.changes, [], adapter.name);
		const dry = adapter.write(ROUTES, { cwd: dir, dryRun: true });
		assert.ok(dry.changes.length > 0, adapter.name);
		assert.throws(() => readFileSync(dry.path), adapter.name);
	}
});
