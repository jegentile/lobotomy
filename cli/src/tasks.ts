/**
 * The shared task vocabulary. Every adapter maps a subset of these onto the
 * knobs its agent actually has.
 */
export interface Task {
	id: string;
	label: string;
	hint: string;
}

export const TASKS: readonly Task[] = [
	{ id: "main", label: "Main", hint: "the main conversation and code edits" },
	{ id: "plan", label: "Plan", hint: "planning and architecture before changes" },
	{ id: "quick", label: "Quick", hint: "cheap one-off questions" },
	{ id: "review", label: "Review", hint: "code review" },
	{ id: "commit", label: "Commit", hint: "commit messages and PR text" },
	{ id: "compact", label: "Compact", hint: "context summaries, titles, compaction" },
	{ id: "subagent", label: "Subagents", hint: "delegated subtasks" },
	{ id: "edit", label: "Edit", hint: "applying edits (agents with an editor/apply model)" },
];

export const LEVELS = ["low", "medium", "high", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** `model` is `provider/model-id`; absent means "the agent's own default". */
export interface Route {
	model?: string;
	level?: Level;
}

export interface Config {
	/** Routes by task id. */
	tasks: Record<string, Route>;
	/** Per-agent overrides, by adapter name then task id. */
	agents?: Record<string, Record<string, Route>>;
}

export const EMPTY_CONFIG: Config = { tasks: {} };

export function isLevel(value: unknown): value is Level {
	return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function isRouted(model: unknown): model is string {
	return typeof model === "string" && model.trim() !== "" && model !== "inherit";
}

export function normalizeRoutes(raw: unknown): Record<string, Route> {
	const out: Record<string, Route> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const { model, level } = value as { model?: unknown; level?: unknown };
		const route: Route = {};
		if (isRouted(model)) route.model = model.trim();
		if (isLevel(level)) route.level = level;
		if (route.model !== undefined || route.level !== undefined) out[key] = route;
	}
	return out;
}

export function normalizeConfig(raw: unknown): Config {
	const value = (raw ?? {}) as { tasks?: unknown; agents?: unknown };
	const config: Config = { tasks: normalizeRoutes(value.tasks) };
	if (value.agents && typeof value.agents === "object") {
		const agents: Record<string, Record<string, Route>> = {};
		for (const [name, routes] of Object.entries(value.agents as Record<string, unknown>)) {
			const clean = normalizeRoutes(routes);
			if (Object.keys(clean).length > 0) agents[name] = clean;
		}
		if (Object.keys(agents).length > 0) config.agents = agents;
	}
	return config;
}

/** The effective route for `task` in `agent`: the agent's override, else the shared route. */
export function routeFor(config: Config, agent: string | undefined, task: string): Route | undefined {
	const override = agent ? config.agents?.[agent]?.[task] : undefined;
	const route = override ?? config.tasks[task];
	if (!route) return undefined;
	if (!isRouted(route.model) && !isLevel(route.level)) return undefined;
	return route;
}

/** Splits `provider/model-id`; a bare id has no provider. */
export function parseModelRef(ref: string): { provider?: string; id: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0) return { id: ref };
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function describeRoute(route: Route | undefined): string {
	if (!route) return "inherit";
	const model = isRouted(route.model) ? route.model : "inherit";
	return isLevel(route.level) ? `${model} @ ${route.level}` : model;
}

export function withRoute(config: Config, agent: string | undefined, task: string, route: Route): Config {
	const clean: Route = {};
	if (isRouted(route.model)) clean.model = route.model.trim();
	if (isLevel(route.level)) clean.level = route.level;
	const remove = clean.model === undefined && clean.level === undefined;
	if (!agent) {
		const tasks = { ...config.tasks };
		if (remove) delete tasks[task];
		else tasks[task] = clean;
		return { ...config, tasks };
	}
	const agents = { ...(config.agents ?? {}) };
	const routes = { ...(agents[agent] ?? {}) };
	if (remove) delete routes[task];
	else routes[task] = clean;
	if (Object.keys(routes).length === 0) delete agents[agent];
	else agents[agent] = routes;
	const next: Config = { tasks: config.tasks };
	if (Object.keys(agents).length > 0) next.agents = agents;
	return next;
}
