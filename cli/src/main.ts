/**
 * `lobotomy`: one routes file, written into every coding agent that reads
 * config files. Run with no arguments for the picker.
 */
import { ADAPTERS } from "./adapters/index.ts";
import type { Adapter } from "./adapters/types.ts";
import { configPath, loadConfig, saveConfig } from "./store.ts";
import { type Config, describeRoute, isLevel, LEVELS, type Level, type Route, routeFor, TASKS, withRoute } from "./tasks.ts";
import { ask, isInteractive, type Item, pick, style } from "./tui.ts";

const HELP = `lobotomy: one brain per task

  lobotomy                         open the picker
  lobotomy status                  list the routes and what each agent would get
  lobotomy set <task> <model> [level]          set a shared route
  lobotomy set <agent>:<task> <model> [level]  set a route for one agent only
  lobotomy clear <task> | <agent>:<task>
  lobotomy apply [agent...] [--project] [--dry-run]   write the agents' config files
  lobotomy agents                  list the agents and the tasks each honours
  lobotomy reset

tasks:  ${TASKS.map((t) => t.id).join(", ")}
levels: ${LEVELS.join(", ")}
agents: ${ADAPTERS.map((a) => a.name).join(", ")}
models: provider/model-id, e.g. anthropic/claude-haiku-4-5 (each agent is told its own spelling)
file:   ${configPath()}
`;

/** Well-known models offered in the picker; anything else can be typed. */
const SUGGESTED_MODELS: Item[] = [
	{ value: "inherit", label: "inherit", description: "the agent's own default" },
	{ value: "anthropic/claude-fable-5-1", label: "anthropic/claude-fable-5-1", description: "strongest" },
	{ value: "anthropic/claude-opus-5-5", label: "anthropic/claude-opus-5-5" },
	{ value: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5" },
	{ value: "anthropic/claude-haiku-4-5", label: "anthropic/claude-haiku-4-5", description: "cheapest" },
	{ value: "openai/gpt-5", label: "openai/gpt-5" },
	{ value: "openai/gpt-5-mini", label: "openai/gpt-5-mini" },
	{ value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
	{ value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash" },
];

function parseKey(key: string): { agent?: string; task: string } {
	const colon = key.indexOf(":");
	if (colon <= 0) return { task: key };
	return { agent: key.slice(0, colon), task: key.slice(colon + 1) };
}

function adapterNamed(name: string): Adapter {
	const adapter = ADAPTERS.find((a) => a.name === name);
	if (!adapter) throw new Error(`unknown agent "${name}"; one of ${ADAPTERS.map((a) => a.name).join(", ")}`);
	return adapter;
}

function status(config: Config): string {
	const lines = [style.bold("shared routes")];
	for (const task of TASKS) lines.push(`  ${task.id.padEnd(10)} ${describeRoute(config.tasks[task.id])}`);
	for (const adapter of ADAPTERS) {
		const overrides = config.agents?.[adapter.name];
		const rows = adapter.tasks
			.map((task) => {
				const route = routeFor(config, adapter.name, task);
				if (!route) return undefined;
				const mark = overrides?.[task] ? " (override)" : "";
				return `  ${task.padEnd(10)} ${adapter.formatModel(route)}${route.level ? ` @ ${route.level}` : ""}${mark}`;
			})
			.filter((row): row is string => Boolean(row));
		lines.push("", style.bold(adapter.name) + style.dim(`  → ${adapter.target(process.cwd())}`));
		lines.push(...(rows.length ? rows : [style.dim("  nothing routed")]));
	}
	lines.push("", style.dim(`file: ${configPath()}`));
	return lines.join("\n");
}

function apply(config: Config, names: string[], options: { project?: boolean; dryRun?: boolean }): void {
	const adapters = names.length ? names.map(adapterNamed) : ADAPTERS;
	for (const adapter of adapters) {
		const result = adapter.write(config, { cwd: process.cwd(), ...options });
		console.log(`${style.bold(adapter.name)} ${options.dryRun ? "would write" : "wrote"} ${result.path}`);
		for (const change of result.changes) console.log(`  ${change}`);
		if (result.changes.length === 0) console.log(style.dim("  nothing to write"));
		for (const note of result.notes) console.log(`  ${style.warn("note")} ${note}`);
	}
}

async function pickRoute(current: Route | undefined, title: string): Promise<Route | undefined> {
	let model = await pick(`${title}: model`, SUGGESTED_MODELS, { initial: current?.model ?? "inherit", allowCustom: true });
	if (model === undefined) return undefined;
	if (model === "custom") model = (await ask(`${title}: model id (provider/model)`, current?.model ?? "")) ?? "";
	const levels: Item[] = [{ value: "default", label: "default", description: "the model's own" }, ...LEVELS.map((l) => ({ value: l, label: l }))];
	const level = await pick(`${title}: reasoning level`, levels, { initial: current?.level ?? "default" });
	if (level === undefined) return undefined;
	return { model, level: isLevel(level) ? (level as Level) : undefined };
}

async function menu(): Promise<void> {
	let config = loadConfig();
	for (;;) {
		const items: Item[] = TASKS.map((task) => ({ value: `task:${task.id}`, label: `${task.label.padEnd(10)} ${describeRoute(config.tasks[task.id])}`, description: task.hint }));
		items.push({ value: "agents", label: "Per-agent overrides…", description: ADAPTERS.map((a) => a.name).join(", ") });
		items.push({ value: "apply", label: "Apply to agents…", description: "write the config files" });
		items.push({ value: "status", label: "Show status" });
		items.push({ value: "quit", label: "Quit" });
		const choice = await pick("Lobotomy: one brain per task", items, { maxVisible: 14 });
		if (choice === undefined || choice === "quit") return;
		if (choice === "status") {
			console.log(status(config));
			continue;
		}
		if (choice === "apply") {
			const which = await pick("Apply to", [{ value: "*", label: "every agent" }, ...ADAPTERS.map((a) => ({ value: a.name, label: a.name, description: a.description }))]);
			if (which === undefined) continue;
			apply(config, which === "*" ? [] : [which], {});
			continue;
		}
		if (choice === "agents") {
			const agent = await pick("Which agent", ADAPTERS.map((a) => ({ value: a.name, label: a.name, description: a.description })));
			if (agent === undefined) continue;
			const adapter = adapterNamed(agent);
			const task = await pick(
				`${agent}: which task`,
				adapter.tasks.map((id) => {
					const task = TASKS.find((t) => t.id === id);
					const override = config.agents?.[agent]?.[id];
					return { value: id, label: `${(task?.label ?? id).padEnd(10)} ${describeRoute(override)}`, description: override ? "override" : `shared: ${describeRoute(config.tasks[id])}` };
				}),
			);
			if (task === undefined) continue;
			const route = await pickRoute(config.agents?.[agent]?.[task], `${agent}:${task}`);
			if (!route) continue;
			config = withRoute(config, agent, task, route);
			saveConfig(config);
			continue;
		}
		const task = choice.slice("task:".length);
		const route = await pickRoute(config.tasks[task], task);
		if (!route) continue;
		config = withRoute(config, undefined, task, route);
		saveConfig(config);
	}
}

export async function main(argv: string[]): Promise<number> {
	const [verb, ...rest] = argv;
	const flags = new Set(rest.filter((a) => a.startsWith("--")));
	const words = rest.filter((a) => !a.startsWith("--"));
	let config = loadConfig();
	try {
		switch (verb) {
			case undefined:
				if (!isInteractive()) {
					console.log(HELP);
					return 0;
				}
				await menu();
				return 0;
			case "status":
				console.log(status(config));
				return 0;
			case "agents":
				for (const a of ADAPTERS) console.log(`${a.name.padEnd(10)} ${a.description}\n${"".padEnd(10)} tasks: ${a.tasks.join(", ")}\n${"".padEnd(10)} models: ${a.modelHint}\n${"".padEnd(10)} writes: ${a.target(process.cwd())}`);
				return 0;
			case "set": {
				const [key, model, level] = words;
				if (!key || !model) throw new Error("set needs a task and a model: lobotomy set plan anthropic/claude-opus-5-5 [high]");
				if (level !== undefined && !isLevel(level)) throw new Error(`unknown level "${level}"; one of ${LEVELS.join(", ")}`);
				const { agent, task } = parseKey(key);
				if (agent) adapterNamed(agent);
				config = withRoute(config, agent, task, { model, level: level as Level | undefined });
				saveConfig(config);
				console.log(`${key} → ${describeRoute(routeFor(config, agent, task))}`);
				return 0;
			}
			case "clear": {
				const [key] = words;
				if (!key) throw new Error("clear needs a task: lobotomy clear plan");
				const { agent, task } = parseKey(key);
				config = withRoute(config, agent, task, {});
				saveConfig(config);
				console.log(`${key} → inherit`);
				return 0;
			}
			case "reset":
				saveConfig({ tasks: {} });
				console.log("every route cleared");
				return 0;
			case "apply":
				apply(config, words, { project: flags.has("--project"), dryRun: flags.has("--dry-run") });
				return 0;
			case "help":
			case "--help":
			case "-h":
				console.log(HELP);
				return 0;
			default:
				throw new Error(`unknown command "${verb}"; try lobotomy help`);
		}
	} catch (error) {
		console.error(`lobotomy: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
