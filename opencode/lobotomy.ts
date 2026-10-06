/**
 * Lobotomy for OpenCode: one brain per task.
 *
 * Reads the shared routes file (`~/.config/lobotomy/lobotomy.json`, written by
 * the `lobotomy` CLI) when OpenCode loads its config, and maps the tasks onto
 * OpenCode's agents:
 *
 *   main → build        plan → plan        subagent → general
 *   explore → explore   compact → title, summary, compaction and small_model
 *
 * It also adds `/quick <question>`, `/review [focus]` and `/commit [hint]`
 * commands that run on their task's model, and a `lobotomy` tool so you can
 * ask the agent to show or change routes ("route planning to haiku").
 *
 * The `main` and `plan` routes are applied to every message as it arrives
 * (the build and plan agents), so a change takes effect on the next message.
 * The subagent, explore and compact routes and the commands are applied when
 * OpenCode loads its config, so those need a restart.
 *
 * Install: copy or symlink this file into `~/.config/opencode/plugins/` (every
 * project) or `.opencode/plugins/` (one project).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";

type Level = "low" | "medium" | "high" | "max";
interface Route {
	model?: string;
	level?: Level;
}
interface Config {
	tasks: Record<string, Route>;
	agents?: Record<string, Record<string, Route>>;
}

const ADAPTER = "opencode";
const LEVELS: readonly Level[] = ["low", "medium", "high", "max"];

/** Task → the OpenCode agents it configures. */
const AGENTS_FOR_TASK: Record<string, string[]> = {
	main: ["build"],
	plan: ["plan"],
	subagent: ["general"],
	explore: ["explore"],
	compact: ["title", "summary", "compaction"],
};

/** Which OpenCode variant to ask for at each level, when the model has them. */
const VARIANT_FOR_LEVEL: Record<Level, string> = { low: "low", medium: "medium", high: "high", max: "max" };

function configPath(): string {
	if (process.env.LOBOTOMY_CONFIG) return process.env.LOBOTOMY_CONFIG;
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "lobotomy", "lobotomy.json");
}

function isRouted(model: unknown): model is string {
	return typeof model === "string" && model.trim() !== "" && model !== "inherit";
}

function normalizeRoutes(raw: unknown): Record<string, Route> {
	const out: Record<string, Route> = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const { model, level } = value as { model?: unknown; level?: unknown };
		const route: Route = {};
		if (isRouted(model)) route.model = model.trim();
		if (typeof level === "string" && (LEVELS as readonly string[]).includes(level)) route.level = level as Level;
		if (route.model !== undefined || route.level !== undefined) out[key] = route;
	}
	return out;
}

function loadConfig(): Config {
	const path = configPath();
	if (!existsSync(path)) return { tasks: {} };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { tasks?: unknown; agents?: unknown };
		const config: Config = { tasks: normalizeRoutes(raw.tasks) };
		if (raw.agents && typeof raw.agents === "object") {
			config.agents = {};
			for (const [name, routes] of Object.entries(raw.agents as Record<string, unknown>)) config.agents[name] = normalizeRoutes(routes);
		}
		return config;
	} catch {
		return { tasks: {} };
	}
}

function saveConfig(config: Config): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** The route for `task`: this adapter's override, else the shared one. */
function routeFor(config: Config, task: string): Route | undefined {
	const route = config.agents?.[ADAPTER]?.[task] ?? config.tasks[task];
	if (!route || (!isRouted(route.model) && !route.level)) return undefined;
	return route;
}

function describe(route: Route | undefined): string {
	if (!route) return "inherit";
	return `${isRouted(route.model) ? route.model : "inherit"}${route.level ? ` @ ${route.level}` : ""}`;
}

type AgentConfig = { model?: string; variant?: string; [key: string]: unknown };
type OpencodeConfig = {
	small_model?: string;
	agent?: Record<string, AgentConfig | undefined>;
	command?: Record<string, { template: string; description?: string; agent?: string; model?: string; variant?: string; subtask?: boolean }>;
};

/** Applies the routes to a config object; returns one line per change. */
function applyRoutes(config: Config, target: OpencodeConfig): string[] {
	const changes: string[] = [];
	target.agent ??= {};
	for (const [task, agents] of Object.entries(AGENTS_FOR_TASK)) {
		const route = routeFor(config, task);
		if (!route) continue;
		for (const name of agents) {
			const agent: AgentConfig = { ...(target.agent[name] ?? {}) };
			if (isRouted(route.model)) agent.model = route.model;
			if (route.level) agent.variant = VARIANT_FOR_LEVEL[route.level];
			target.agent[name] = agent;
			changes.push(`agent.${name} ← ${describe(route)} (${task})`);
		}
	}
	const compact = routeFor(config, "compact");
	if (compact && isRouted(compact.model)) {
		target.small_model = compact.model;
		changes.push(`small_model ← ${compact.model} (compact)`);
	}
	target.command ??= {};
	const commands: Record<string, { task: string; description: string; template: string }> = {
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
	for (const [name, spec] of Object.entries(commands)) {
		if (target.command[name]) continue; // the person's own command wins
		const route = routeFor(config, spec.task);
		target.command[name] = {
			template: spec.template,
			description: spec.description,
			...(route && isRouted(route.model) ? { model: route.model } : {}),
			...(route?.level ? { variant: VARIANT_FOR_LEVEL[route.level] } : {}),
		};
		if (route) changes.push(`command.${name} ← ${describe(route)} (${spec.task})`);
	}
	if (!target.command.lobotomy) {
		target.command.lobotomy = {
			template: "Use the lobotomy tool with action \"status\" and show me the routes it returns, then stop.",
			description: "Show which model runs each task",
		};
	}
	return changes;
}

/** Which task a primary agent's messages belong to. */
const TASK_FOR_AGENT: Record<string, string> = { build: "main", plan: "plan" };

const LobotomyPlugin: Plugin = async ({ client }) => {
	let applied: string[] = [];
	/** Sessions whose next message comes from a slash command, which carries its own model. */
	const commandSessions = new Set<string>();
	return {
		"command.execute.before": async (input) => {
			commandSessions.add(input.sessionID);
		},
		"chat.message": async (input, output) => {
			if (commandSessions.delete(input.sessionID)) return;
			const agent = output.message.agent ?? input.agent;
			const task = agent ? TASK_FOR_AGENT[agent] : undefined;
			if (!task) return;
			const route = routeFor(loadConfig(), task);
			if (!route || !isRouted(route.model)) return;
			const slash = route.model.indexOf("/");
			if (slash <= 0) return;
			output.message.model = { providerID: route.model.slice(0, slash), modelID: route.model.slice(slash + 1) };
			if (route.level) (output.message as { variant?: string }).variant = VARIANT_FOR_LEVEL[route.level];
		},
		config: async (input) => {
			if (!input || typeof input !== "object") return;
			applied = applyRoutes(loadConfig(), input as OpencodeConfig);
		},
		tool: {
			lobotomy: tool({
				description:
					"Show or change which model runs each task (main, plan, quick, review, commit, compact, subagent, explore). Models are provider/model-id as OpenCode names them. Changes take effect when OpenCode restarts.",
				args: {
					action: tool.schema.enum(["status", "set", "clear"]).describe("status lists the routes; set assigns a model; clear removes a route"),
					task: tool.schema.string().optional().describe("the task, for set and clear"),
					model: tool.schema.string().optional().describe("provider/model-id, for set"),
					level: tool.schema.enum(LEVELS as [Level, ...Level[]]).optional().describe("reasoning effort, for set"),
				},
				async execute(args) {
					const config = loadConfig();
					if (args.action === "status") {
						const lines = Object.keys({ ...config.tasks, ...(config.agents?.[ADAPTER] ?? {}) })
							.sort()
							.map((task) => `${task.padEnd(10)} ${describe(routeFor(config, task))}`);
						return [
							lines.length ? lines.join("\n") : "nothing routed; every task uses OpenCode's defaults",
							applied.length ? `\napplied at startup:\n${applied.join("\n")}` : "\nnothing applied at startup",
							`\nfile: ${configPath()}`,
						].join("\n");
					}
					if (!args.task) return "set and clear need a task";
					const routes = { ...(config.agents?.[ADAPTER] ?? {}) };
					if (args.action === "clear") delete routes[args.task];
					else {
						if (!isRouted(args.model) && !args.level) return "set needs a model or a level";
						const route: Route = {};
						if (isRouted(args.model)) route.model = args.model;
						if (args.level) route.level = args.level;
						routes[args.task] = route;
					}
					config.agents = { ...(config.agents ?? {}), [ADAPTER]: routes };
					saveConfig(config);
					const live = args.task === "main" || args.task === "plan";
					return `${args.task} → ${describe(routeFor(config, args.task))} (saved for opencode in ${configPath()}; ${live ? "applies from the next message" : "applies after OpenCode restarts"})`;
				},
			}),
		},
		event: async ({ event }) => {
			if (event.type === "session.created" && applied.length > 0) {
				await client.tui.showToast({ body: { message: `lobotomy: ${applied.length} route${applied.length === 1 ? "" : "s"} applied (/lobotomy)`, variant: "info" } }).catch(() => undefined);
			}
		},
	};
};

export default LobotomyPlugin;
