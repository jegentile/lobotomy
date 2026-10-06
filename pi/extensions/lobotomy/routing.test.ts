import assert from "node:assert/strict";
import { test } from "node:test";

import { describeConfig, mergeConfigs, normalizeConfig, parseCommand, parseModelRef, resolveTask, withRoute } from "./routing.ts";

const config = normalizeConfig({
	tasks: {
		main: { level: "medium" },
		plan: { model: "anthropic/claude-opus-4-8", level: "high" },
		quick: { model: "anthropic/claude-haiku-4-5" },
		junk: { model: 7 },
		empty: { model: "inherit" },
	},
});

test("normalizeConfig keeps only well-formed routes", () => {
	assert.equal(config.tasks.junk, undefined);
	assert.equal(config.tasks.empty, undefined);
	assert.deepEqual(config.tasks.main, { level: "medium" });
});

test("resolveTask: pending task, then plan mode, then main", () => {
	assert.deepEqual(resolveTask(config, {}), { task: "main", route: { level: "medium" } });
	assert.equal(resolveTask(config, { planMode: true })?.task, "plan");
	assert.equal(resolveTask(config, { task: "quick", planMode: true })?.route.model, "anthropic/claude-haiku-4-5");
	assert.equal(resolveTask(config, { task: "review" })?.task, "main");
	assert.equal(resolveTask({ tasks: {} }, { task: "quick" }), undefined);
});

test("parseModelRef splits provider and id", () => {
	assert.deepEqual(parseModelRef("anthropic/claude-haiku-4-5"), { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.deepEqual(parseModelRef("claude-haiku-4-5"), { id: "claude-haiku-4-5" });
	assert.equal(parseModelRef("  "), undefined);
});

test("withRoute and mergeConfigs", () => {
	let next = withRoute({ tasks: {} }, "plan", { model: "openai/gpt-5", level: "max" });
	assert.deepEqual(next.tasks.plan, { model: "openai/gpt-5", level: "max" });
	next = withRoute(next, "plan", { model: "inherit" });
	assert.equal(next.tasks.plan, undefined);
	const merged = mergeConfigs({ tasks: { main: { model: "a/b" }, quick: { model: "a/c" } } }, { tasks: { main: { model: "p/q" } } });
	assert.deepEqual(merged.tasks, { main: { model: "p/q" }, quick: { model: "a/c" } });
});

test("parseCommand reads every form", () => {
	assert.deepEqual(parseCommand(""), { kind: "screen" });
	assert.deepEqual(parseCommand("set plan anthropic/claude-opus-4-8 high"), {
		kind: "set",
		key: "plan",
		route: { model: "anthropic/claude-opus-4-8", level: "high" },
	});
	assert.deepEqual(parseCommand("quick anthropic/claude-haiku-4-5"), {
		kind: "set",
		key: "quick",
		route: { model: "anthropic/claude-haiku-4-5", level: undefined },
	});
	assert.equal(parseCommand("set plan x bogus").kind, "error");
	assert.deepEqual(parseCommand("clear plan"), { kind: "clear", key: "plan" });
});

test("describeConfig lists routes in task order", () => {
	assert.match(describeConfig({ tasks: {} }), /nothing routed/);
	const text = describeConfig(config);
	assert.ok(text.indexOf("main") < text.indexOf("plan"));
	assert.match(text, /plan\s+anthropic\/claude-opus-4-8 @ high/);
});
