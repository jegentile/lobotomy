/**
 * Pure routing logic for the pi extension: no pi imports, no I/O, so
 * `node --test` runs it directly.
 */

export type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const LEVELS: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `model` is `provider/model-id` (or a bare id), `inherit`, or absent. */
export interface Route {
	model?: string;
	level?: Level;
}

export interface Config {
	tasks: Record<string, Route>;
}

export interface Task {
	id: string;
	label: string;
	hint: string;
}

/** The tasks a person assigns a brain to, in the order the screen lists them. */
export const TASKS: readonly Task[] = [
	{ id: "main", label: "Main", hint: "the main conversation" },
	{ id: "plan", label: "Plan", hint: "/plan: read-only planning mode" },
	{ id: "quick", label: "Quick", hint: "/quick <question>: cheap one-off answers" },
	{ id: "review", label: "Review", hint: "/review [focus]: review the working tree" },
	{ id: "commit", label: "Commit", hint: "/commit [hint]: write and make the commit" },
	{ id: "compact", label: "Compact", hint: "compaction and branch summaries" },
];

export const EMPTY_CONFIG: Config = { tasks: {} };

export function isRouted(model: string | undefined): model is string {
	return typeof model === "string" && model !== "" && model !== "inherit" && model !== "default";
}

export function isLevel(level: string | undefined): level is Level {
	return typeof level === "string" && (LEVELS as readonly string[]).includes(level);
}

/** The route for `key`, or undefined when it routes nothing. */
export function routeFor(config: Config, key: string): Route | undefined {
	const route = config.tasks[key];
	if (!route) return undefined;
	if (!isRouted(route.model) && !isLevel(route.level)) return undefined;
	return route;
}

export interface Resolved {
	task: string;
	route: Route;
}

/**
 * The route for the next request: the pending task when one was assigned and
 * routes, else plan mode's, else main's.
 */
export function resolveTask(config: Config, ctx: { task?: string | null; planMode?: boolean }): Resolved | undefined {
	const candidates: string[] = [];
	if (ctx.task) candidates.push(ctx.task);
	if (ctx.planMode) candidates.push("plan");
	candidates.push("main");
	for (const task of candidates) {
		const route = routeFor(config, task);
		if (route) return { task, route };
	}
	return undefined;
}

/** `provider/id` → its parts; a bare id has no provider. */
export function parseModelRef(ref: string): { provider?: string; id: string } | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return { id: trimmed };
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** A copy of `config` with `key` set to `route`, or removed when it routes nothing. */
export function withRoute(config: Config, key: string, route: Route): Config {
	const tasks = { ...config.tasks };
	const next: Route = {};
	if (isRouted(route.model)) next.model = route.model;
	if (isLevel(route.level)) next.level = route.level;
	if (next.model === undefined && next.level === undefined) delete tasks[key];
	else tasks[key] = next;
	return { tasks };
}

/** Reads a parsed JSON value back into a config, dropping anything malformed. */
export function normalizeConfig(value: unknown): Config {
	const tasks: Record<string, Route> = {};
	const raw = (value as { tasks?: unknown } | undefined)?.tasks;
	if (raw && typeof raw === "object") {
		for (const [key, route] of Object.entries(raw as Record<string, unknown>)) {
			if (!route || typeof route !== "object") continue;
			const { model, level } = route as { model?: unknown; level?: unknown };
			const clean: Route = {};
			if (typeof model === "string" && isRouted(model)) clean.model = model;
			if (typeof level === "string" && isLevel(level)) clean.level = level;
			if (clean.model !== undefined || clean.level !== undefined) tasks[key] = clean;
		}
	}
	return { tasks };
}

/** Project routes over global ones, task by task. */
export function mergeConfigs(global: Config, project: Config): Config {
	return { tasks: { ...global.tasks, ...project.tasks } };
}

export function describeRoute(route: Route | undefined): string {
	if (!route) return "inherit";
	const model = isRouted(route.model) ? route.model : "inherit";
	return isLevel(route.level) ? `${model} @ ${route.level}` : model;
}

export function describeConfig(config: Config): string {
	const keys = Object.keys(config.tasks);
	if (keys.length === 0) return "lobotomy: nothing routed; every task uses the session model.";
	const order = new Map(TASKS.map((task, i) => [task.id, i] as const));
	keys.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b));
	return keys.map((key) => `${key.padEnd(10)} ${describeRoute(config.tasks[key])}`).join("\n");
}

export type Command =
	| { kind: "screen" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "reset" }
	| { kind: "clear"; key: string }
	| { kind: "set"; key: string; route: Route }
	| { kind: "error"; message: string };

/** Parses `/lobotomy` arguments. */
export function parseCommand(args: string): Command {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const [verb, key, model, level] = words;
	if (!verb) return { kind: "screen" };
	switch (verb) {
		case "status":
		case "list":
			return { kind: "status" };
		case "help":
			return { kind: "help" };
		case "reset":
			return { kind: "reset" };
		case "clear":
			return key ? { kind: "clear", key } : { kind: "error", message: "clear needs a task: /lobotomy clear plan" };
		case "set": {
			if (!key || !model) {
				return { kind: "error", message: "set needs a task and a model: /lobotomy set quick anthropic/claude-haiku-4-5 [low]" };
			}
			if (level && !isLevel(level)) {
				return { kind: "error", message: `unknown thinking level "${level}"; one of ${LEVELS.join(", ")}` };
			}
			return { kind: "set", key, route: { model, level: level as Level | undefined } };
		}
		default:
			if (words.length >= 2) return parseCommand(`set ${args}`);
			return { kind: "error", message: `unknown subcommand "${verb}"; try /lobotomy help` };
	}
}

export const HELP = [
	"/lobotomy                 open the config screen",
	"/lobotomy status          list the routes",
	"/lobotomy set <task> <provider/model> [thinking]",
	"/lobotomy clear <task>    route the task to the session model again",
	"/lobotomy reset           clear every route",
	"/quick <question>         ask one question on the quick route",
	"/plan [on|off]            toggle read-only planning on the plan route",
	"/review [focus]           review the working tree on the review route",
	"/commit [hint]            commit on the commit route",
	"",
	`tasks: ${TASKS.map((t) => t.id).join(", ")}`,
	`thinking: ${LEVELS.join(", ")}`,
].join("\n");
