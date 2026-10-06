import assert from "node:assert/strict";
import { test } from "node:test";

import { describeRoute, normalizeConfig, parseModelRef, routeFor, withRoute } from "./tasks.ts";

test("normalizeConfig drops malformed routes and empty agents", () => {
	const config = normalizeConfig({
		tasks: { plan: { model: "anthropic/claude-opus-5-5", level: "high" }, junk: { model: 3 }, empty: { model: "inherit" } },
		agents: { aider: { commit: { model: "anthropic/claude-haiku-4-5" } }, goose: { bad: {} } },
	});
	assert.deepEqual(config.tasks, { plan: { model: "anthropic/claude-opus-5-5", level: "high" } });
	assert.deepEqual(config.agents, { aider: { commit: { model: "anthropic/claude-haiku-4-5" } } });
});

test("routeFor prefers the agent override", () => {
	const config = normalizeConfig({ tasks: { commit: { model: "a/b" } }, agents: { aider: { commit: { model: "c/d" } } } });
	assert.equal(routeFor(config, "aider", "commit")?.model, "c/d");
	assert.equal(routeFor(config, "goose", "commit")?.model, "a/b");
	assert.equal(routeFor(config, undefined, "plan"), undefined);
});

test("withRoute sets and clears shared and per-agent routes", () => {
	let config = withRoute({ tasks: {} }, undefined, "plan", { model: "a/b", level: "max" });
	config = withRoute(config, "crush", "plan", { model: "c/d" });
	assert.deepEqual(config, { tasks: { plan: { model: "a/b", level: "max" } }, agents: { crush: { plan: { model: "c/d" } } } });
	config = withRoute(config, "crush", "plan", { model: "inherit" });
	assert.equal(config.agents, undefined);
	config = withRoute(config, undefined, "plan", {});
	assert.deepEqual(config, { tasks: {} });
});

test("parseModelRef and describeRoute", () => {
	assert.deepEqual(parseModelRef("anthropic/claude-haiku-4-5"), { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.deepEqual(parseModelRef("gpt-5"), { id: "gpt-5" });
	assert.equal(describeRoute({ model: "a/b", level: "low" }), "a/b @ low");
	assert.equal(describeRoute(undefined), "inherit");
});
