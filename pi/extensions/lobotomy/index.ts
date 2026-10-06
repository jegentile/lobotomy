/**
 * Lobotomy for pi: one brain per task.
 *
 * Routes the main chat, `/plan`, `/quick`, `/review`, `/commit` and
 * compaction to the model and thinking level the person chose. Routes live in
 * `~/.pi/agent/lobotomy.json` (and `.pi/lobotomy.json` per project).
 *
 * Two routing paths, picked at load:
 *  - pi ≥ 1.0 (`pi.registerVirtualModel`): a virtual model `lobotomy/auto`
 *    routes every request, compaction included, with no model switches
 *    recorded in the session. Select it with `/model lobotomy/auto` or
 *    `pi --model lobotomy/auto`.
 *  - every pi: the extension switches the session model with `pi.setModel`
 *    before each task and restores it afterwards.
 */
import { type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact, generateBranchSummary } from "@earendil-works/pi-coding-agent";

import { globalPath, loadConfig, projectPath, readConfigFile, writeConfigFile } from "./config.ts";
import {
	type Config,
	describeRoute,
	EMPTY_CONFIG,
	HELP,
	describeConfig,
	isLevel,
	isRouted,
	type Level,
	LEVELS,
	parseCommand,
	parseModelRef,
	resolveTask,
	type Route,
	routeFor,
	withRoute,
} from "./routing.ts";
import { type SaveTarget, showConfigScreen } from "./ui.ts";

const VIRTUAL_PROVIDER = "lobotomy";
const VIRTUAL_ID = "auto";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const PLAN_INSTRUCTIONS = [
	"You are in PLANNING MODE (lobotomy /plan). Do not change any file: you only have read-only tools.",
	"Understand the request, read the relevant code in full, and produce a numbered implementation plan:",
	"what to change, where, why, and the risks. End by asking whether to proceed; the person will run /plan off to implement.",
].join(" ");

/** The subset of the virtual-model API this extension uses, so it compiles on pi versions without it. */
interface VirtualRouteRequest {
	thinkingLevel: Level;
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: { model: Model<Api>; thinkingLevel?: Level };
	state?: { task: string };
}
interface VirtualRoute {
	model: Model<Api>;
	thinkingLevel: Level;
	state?: { task: string };
}
interface VirtualModelApi {
	registerVirtualModel?: (definition: {
		provider: string;
		id: string;
		name: string;
		thinkingLevels?: readonly Level[];
		input?: ("text" | "image")[];
		route: (request: VirtualRouteRequest, ctx: ExtensionContext) => VirtualRoute | Promise<VirtualRoute>;
	}) => void;
}

export default function lobotomy(pi: ExtensionAPI) {
	let config: Config = EMPTY_CONFIG;
	let target: SaveTarget = "global";
	/** The task the next requests belong to, until the agent settles. */
	let pendingTask: string | null = null;
	let planMode = false;
	let toolsBeforePlan: string[] | undefined;
	/** The model and level the person chose, to come back to after a routed task. */
	let userModel: Model<Api> | undefined;
	let userLevel: Level | undefined;
	/** True while this extension switches the model, so its own events are ignored. */
	let switching = false;

	const virtualApi = pi as unknown as VirtualModelApi;
	const hasVirtualModels = typeof virtualApi.registerVirtualModel === "function";

	// ---------------------------------------------------------------- models

	function findModel(ctx: ExtensionContext, ref: string | undefined): Model<Api> | undefined {
		if (!isRouted(ref)) return undefined;
		const parsed = parseModelRef(ref);
		if (!parsed) return undefined;
		if (parsed.provider) return ctx.modelRegistry.find(parsed.provider, parsed.id);
		const all = ctx.modelRegistry.getAll().filter((model) => model.id === parsed.id);
		return all.find((model) => ctx.modelRegistry.hasConfiguredAuth(model)) ?? all[0];
	}

	function isVirtual(model: Model<Api> | undefined): boolean {
		return model?.provider === VIRTUAL_PROVIDER && model?.id === VIRTUAL_ID;
	}

	function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
		return a?.provider === b?.provider && a?.id === b?.id;
	}

	function status(ctx: ExtensionContext, text: string | undefined) {
		ctx.ui.setStatus("lobotomy", text === undefined ? undefined : ctx.ui.theme.fg("accent", `🧠 ${text}`));
	}

	/**
	 * Switch-based routing: put the session on the task's model and level, or
	 * back on the person's own when the task routes nothing.
	 */
	async function applyTask(task: string | null, ctx: ExtensionContext): Promise<void> {
		if (isVirtual(ctx.model)) return; // the virtual model routes per request
		const hit = resolveTask(config, { task, planMode });
		const wanted = (hit && findModel(ctx, hit.route.model)) ?? userModel;
		if (hit && isRouted(hit.route.model) && !findModel(ctx, hit.route.model)) {
			ctx.ui.notify(`lobotomy: model ${hit.route.model} for "${hit.task}" is not in the catalog; using the session model`, "warning");
		}
		const level = hit && isLevel(hit.route.level) ? hit.route.level : userLevel;
		switching = true;
		try {
			if (wanted && !sameModel(wanted, ctx.model)) {
				const ok = await pi.setModel(wanted);
				if (!ok) ctx.ui.notify(`lobotomy: no credentials for ${wanted.provider}/${wanted.id}`, "warning");
			}
			if (level && level !== pi.getThinkingLevel()) pi.setThinkingLevel(level);
		} finally {
			switching = false;
		}
		const routed = hit && (hit.task !== "main" || isRouted(hit.route.model) || isLevel(hit.route.level));
		status(ctx, routed ? `${hit.task} → ${describeRoute(hit.route)}` : undefined);
	}

	// ---------------------------------------------------------------- config

	function reload(ctx: ExtensionContext) {
		config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
	}

	function targetPath(ctx: ExtensionContext): string {
		return target === "project" ? projectPath(ctx.cwd) : globalPath();
	}

	function saveRoute(ctx: ExtensionContext, key: string, route: Route) {
		const path = targetPath(ctx);
		writeConfigFile(path, withRoute(readConfigFile(path), key, route));
		reload(ctx);
	}

	function resetRoutes(ctx: ExtensionContext) {
		writeConfigFile(targetPath(ctx), EMPTY_CONFIG);
		reload(ctx);
	}

	// ------------------------------------------------------------- commands

	pi.registerCommand("lobotomy", {
		description: "Pick which model runs each task (main, plan, quick, review, commit, compact)",
		getArgumentCompletions: (prefix) => {
			const words = ["set", "clear", "status", "reset", "help"];
			const items = words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			reload(ctx);
			const command = parseCommand(args);
			switch (command.kind) {
				case "screen":
					await showConfigScreen(ctx, {
						config: () => config,
						target: () => target,
						onRoute: (key, route) => saveRoute(ctx, key, route),
						onTarget: (next) => {
							target = next;
						},
						onReset: () => resetRoutes(ctx),
					});
					await applyTask(pendingTask, ctx);
					return;
				case "status":
					ctx.ui.notify(`${describeConfig(config)}\nsaving to: ${targetPath(ctx)}`, "info");
					return;
				case "help":
					ctx.ui.notify(HELP, "info");
					return;
				case "reset":
					resetRoutes(ctx);
					ctx.ui.notify(`lobotomy: every route cleared in ${targetPath(ctx)}`, "info");
					await applyTask(pendingTask, ctx);
					return;
				case "clear":
					saveRoute(ctx, command.key, {});
					ctx.ui.notify(`lobotomy: ${command.key} routes to the session model again`, "info");
					await applyTask(pendingTask, ctx);
					return;
				case "set": {
					if (isRouted(command.route.model) && !findModel(ctx, command.route.model)) {
						ctx.ui.notify(`lobotomy: ${command.route.model} is not in the catalog (see /model); saved anyway`, "warning");
					}
					saveRoute(ctx, command.key, command.route);
					ctx.ui.notify(`lobotomy: ${command.key} → ${describeRoute(config.tasks[command.key])}`, "info");
					await applyTask(pendingTask, ctx);
					return;
				}
				case "error":
					ctx.ui.notify(`lobotomy: ${command.message}`, "error");
					return;
			}
		},
	});

	/** Runs one prompt on a task's route. */
	async function runTask(task: string, prompt: string, ctx: ExtensionContext): Promise<void> {
		pendingTask = task;
		await applyTask(task, ctx);
		if (!routeFor(config, task)) ctx.ui.notify(`lobotomy: no route for "${task}"; using the session model (/lobotomy set ${task} <model>)`, "info");
		pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	pi.registerCommand("quick", {
		description: "Ask one question on the quick route (a cheap model)",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /quick <question>", "warning");
				return;
			}
			await runTask("quick", question, ctx);
		},
	});

	pi.registerCommand("review", {
		description: "Review the working tree on the review route",
		handler: async (args, ctx) => {
			const focus = args.trim();
			await runTask(
				"review",
				[
					"Review the current uncommitted changes. Run `git status` and `git diff` (and `git diff --cached`) to see them.",
					"Report correctness bugs first, then risky changes, then smaller cleanups, each with the file and line and a concrete failure scenario.",
					"Do not edit files.",
					focus ? `Focus on: ${focus}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				ctx,
			);
		},
	});

	pi.registerCommand("commit", {
		description: "Commit the working tree on the commit route",
		handler: async (args, ctx) => {
			const hint = args.trim();
			await runTask(
				"commit",
				[
					"Commit the current changes. Run `git status` and `git diff` to see what changed, stage the relevant files, and write a clear commit message:",
					"a short imperative subject line, a blank line, then a body explaining why. Do not push.",
					hint ? `Guidance from the person: ${hint}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				ctx,
			);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle read-only planning mode on the plan route",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w })),
		handler: async (args, ctx) => {
			const word = args.trim().toLowerCase();
			const next = word === "on" ? true : word === "off" ? false : !planMode;
			if (next === planMode) {
				ctx.ui.notify(`lobotomy: plan mode is already ${planMode ? "on" : "off"}`, "info");
				return;
			}
			planMode = next;
			if (planMode) {
				toolsBeforePlan = pi.getActiveTools();
				const available = new Set(pi.getAllTools().map((tool) => tool.name));
				pi.setActiveTools(READ_ONLY_TOOLS.filter((name) => available.has(name)));
				ctx.ui.notify("lobotomy: plan mode on (read-only tools). /plan off to implement.", "info");
			} else {
				if (toolsBeforePlan) pi.setActiveTools(toolsBeforePlan);
				toolsBeforePlan = undefined;
				ctx.ui.notify("lobotomy: plan mode off", "info");
			}
			await applyTask(pendingTask, ctx);
		},
	});

	// --------------------------------------------------------------- events

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		if (ctx.isProjectTrusted() && readConfigFile(projectPath(ctx.cwd)) !== EMPTY_CONFIG) target = "project";
		userModel = isVirtual(ctx.model) ? userModel : ctx.model;
		userLevel = pi.getThinkingLevel();
		pendingTask = null;
		await applyTask(null, ctx);
	});

	pi.on("model_select", async (event, _ctx) => {
		if (switching) return;
		// The person's own choice becomes the model routed tasks come back to.
		if (!isVirtual(event.model)) userModel = event.model;
	});

	pi.on("thinking_level_select", async (event) => {
		if (!switching) userLevel = event.level;
	});

	// Every prompt the person types runs on main (or plan mode); a task's
	// prompt was already routed by its command.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || pendingTask) return;
		await applyTask(null, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!planMode) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_INSTRUCTIONS}` };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingTask) return;
		pendingTask = null;
		await applyTask(null, ctx);
	});

	// Compaction and branch summaries on the "compact" route, using pi's own
	// summarizers with a different model.
	async function summaryModel(ctx: ExtensionContext) {
		const route = routeFor(config, "compact");
		if (!route || !isRouted(route.model)) return undefined;
		const model = findModel(ctx, route.model);
		if (!model) {
			ctx.ui.notify(`lobotomy: compact model ${route.model} not found; pi summarizes with the session model`, "warning");
			return undefined;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`lobotomy: ${auth.error}; pi summarizes with the session model`, "warning");
			return undefined;
		}
		return { model, auth, level: isLevel(route.level) ? route.level : undefined };
	}

	pi.on("session_before_compact", async (event, ctx) => {
		if (isVirtual(ctx.model) && hasVirtualModels) return; // routed as a "direct" request
		const picked = await summaryModel(ctx);
		if (!picked) return;
		try {
			const result = await compact(
				event.preparation,
				picked.model,
				picked.auth.apiKey,
				picked.auth.headers,
				event.customInstructions,
				event.signal,
				picked.level,
				undefined,
				picked.auth.env,
			);
			ctx.ui.notify(`lobotomy: compacted with ${picked.model.provider}/${picked.model.id}`, "info");
			return { compaction: result };
		} catch (error) {
			if (event.signal.aborted) return;
			ctx.ui.notify(`lobotomy: compaction on ${picked.model.id} failed (${error instanceof Error ? error.message : String(error)}); pi retries with the session model`, "warning");
			return;
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		if (!event.preparation.userWantsSummary) return;
		if (isVirtual(ctx.model) && hasVirtualModels) return;
		const picked = await summaryModel(ctx);
		if (!picked) return;
		const result = await generateBranchSummary(event.preparation.entriesToSummarize, {
			model: picked.model,
			apiKey: picked.auth.apiKey,
			headers: picked.auth.headers,
			env: picked.auth.env,
			signal: event.signal,
			customInstructions: event.preparation.customInstructions,
			replaceInstructions: event.preparation.replaceInstructions,
		});
		if (!result.summary || result.aborted || result.error) return;
		return {
			summary: {
				summary: result.summary,
				usage: result.usage,
				details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
			},
		};
	});

	// ---------------------------------------------------------- virtual model

	if (hasVirtualModels) {
		virtualApi.registerVirtualModel?.({
			provider: VIRTUAL_PROVIDER,
			id: VIRTUAL_ID,
			name: "Lobotomy (routes by task)",
			thinkingLevels: LEVELS,
			input: ["text", "image"],
			route: (request, ctx) => {
				let hit = request.reason === "direct" ? routeOrUndefined("compact") : undefined;
				hit ??= resolveTask(config, { task: pendingTask, planMode });
				const task = hit?.task ?? "main";
				// Tool follow-ups and retries stay on the model that started the task.
				if ((request.reason === "continuation" || request.reason === "retry") && request.previous && request.state?.task === task) {
					return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel, state: request.state };
				}
				const model =
					(hit && findModel(ctx, hit.route.model)) ??
					userModel ??
					request.previous?.model ??
					ctx.modelRegistry.getAvailable().find((candidate) => !isVirtual(candidate));
				if (!model) throw new Error("lobotomy: no physical model available; set one with /lobotomy set main <provider/model>");
				const thinkingLevel = hit && isLevel(hit.route.level) ? hit.route.level : request.thinkingLevel;
				if (request.reason !== "direct") status(ctx, `${task} → ${model.provider}/${model.id} @ ${thinkingLevel}`);
				return { model, thinkingLevel, state: { task } };
			},
		});
	}

	function routeOrUndefined(task: string) {
		const route = routeFor(config, task);
		return route ? { task, route } : undefined;
	}
}
