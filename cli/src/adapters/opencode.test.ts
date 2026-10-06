import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { opencode } from "./opencode.ts";

test("opencode adapter writes agents, small_model and commands, keeping the person's own entries", () => {
	const cwd = mkdtempSync(join(tmpdir(), "lobotomy-oc-"));
	const path = join(cwd, "opencode.json");
	writeFileSync(path, JSON.stringify({ model: "anthropic/claude-sonnet-4-5", agent: { plan: { prompt: "keep me" } }, command: { commit: { template: "mine" } } }));
	const result = opencode.write(
		{
			tasks: { plan: { model: "anthropic/claude-opus-4-8", level: "high" }, compact: { model: "anthropic/claude-haiku-4-5" }, commit: { model: "anthropic/claude-haiku-4-5" } },
			agents: { opencode: { quick: { model: "anthropic/claude-haiku-4-5", level: "low" } } },
		},
		{ cwd, project: true },
	);
	assert.equal(result.path, path);
	const written = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(written.model, "anthropic/claude-sonnet-4-5");
	assert.deepEqual(written.agent.plan, { prompt: "keep me", model: "anthropic/claude-opus-4-8", variant: "high" });
	assert.equal(written.agent.title.model, "anthropic/claude-haiku-4-5");
	assert.equal(written.small_model, "anthropic/claude-haiku-4-5");
	assert.equal(written.command.quick.model, "anthropic/claude-haiku-4-5");
	assert.equal(written.command.quick.variant, "low");
	assert.deepEqual(written.command.commit, { template: "mine" });
	assert.ok(result.notes.some((note) => note.includes("command.commit")));
});

test("opencode adapter dry run writes nothing", () => {
	const cwd = mkdtempSync(join(tmpdir(), "lobotomy-oc-"));
	const result = opencode.write({ tasks: { main: { model: "openai/gpt-5" } } }, { cwd, project: true, dryRun: true });
	assert.deepEqual(result.changes, ["agent.build.model = openai/gpt-5"]);
	assert.throws(() => readFileSync(join(cwd, "opencode.json")));
});
