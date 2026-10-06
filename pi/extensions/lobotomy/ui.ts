/**
 * The config screen: a SettingsList with one row per task. Enter on a row
 * opens a two-step picker (model, then thinking level); Esc closes.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Key, matchesKey, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

import { type Config, describeRoute, isLevel, isRouted, type Level, LEVELS, type Route, TASKS } from "./routing.ts";

export type SaveTarget = "global" | "project";

export interface ScreenOptions {
	config: () => Config;
	target: () => SaveTarget;
	onRoute: (key: string, route: Route) => void;
	onTarget: (target: SaveTarget) => void;
	onReset: () => void;
}

const TARGET_ROW = "__target";
const RESET_ROW = "__reset";

function modelItems(models: Model<Api>[], current: string | undefined): SelectItem[] {
	const items: SelectItem[] = [{ value: "inherit", label: "inherit", description: "use the session model" }];
	const sorted = [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	for (const model of sorted) {
		const ref = `${model.provider}/${model.id}`;
		const context = model.contextWindow >= 1_000_000 ? `${Math.round(model.contextWindow / 1_000_000)}M` : `${Math.round(model.contextWindow / 1000)}K`;
		items.push({
			value: ref,
			label: ref === current ? `${ref} (current)` : ref,
			description: `${model.name} · ${context} context${model.reasoning ? " · thinking" : ""}`,
		});
	}
	return items;
}

function levelItems(current: Level | undefined): SelectItem[] {
	const items: SelectItem[] = [{ value: "default", label: "default", description: "keep the session's thinking level" }];
	for (const level of LEVELS) items.push({ value: level, label: level === current ? `${level} (current)` : level });
	return items;
}

/**
 * Two SelectLists in sequence. Resolves through `done` with the route's new
 * description, or undefined when cancelled on the first step.
 */
function routeEditor(
	ctx: ExtensionContext,
	key: string,
	route: Route | undefined,
	onRoute: (key: string, route: Route) => void,
	done: (value?: string) => void,
): Component {
	const theme = ctx.ui.theme;
	const container = new Container();
	let list: SelectList;
	let chosenModel: string | undefined;
	let filter = "";

	const title = (text: string) => new Text(theme.fg("accent", theme.bold(text)), 1, 0);
	const hint = () =>
		new Text(theme.fg("dim", filter ? `filter: ${filter}  (backspace clears)` : "type to filter · ↑↓ move · enter pick · esc back"), 1, 0);

	const matching = (items: SelectItem[]) =>
		filter ? items.filter((item) => `${item.value} ${item.description ?? ""}`.toLowerCase().includes(filter.toLowerCase())) : items;

	const showLevels = () => {
		filter = "";
		container.clear();
		container.addChild(title(`${key}: thinking level`));
		list = new SelectList(levelItems(route?.level), 9, getSelectListTheme());
		list.onSelect = (item) => {
			const next: Route = { model: chosenModel, level: item.value as Level };
			onRoute(key, next);
			done(describeRoute({ model: isRouted(next.model) ? next.model : undefined, level: isLevel(next.level) ? next.level : undefined }));
		};
		list.onCancel = () => showModels();
		container.addChild(list);
		container.addChild(hint());
	};

	const showModels = () => {
		container.clear();
		container.addChild(title(`${key}: model`));
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const items = matching(modelItems(ctx.modelRegistry.getAvailable(), current));
		list = new SelectList(items.length > 0 ? items : [{ value: "inherit", label: "inherit", description: "no model matches the filter" }], 12, getSelectListTheme());
		list.onSelect = (item) => {
			chosenModel = item.value;
			showLevels();
		};
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(hint());
	};

	showModels();

	return {
		render: (width) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data) => {
			// Typing narrows the model list; the level list is short enough as is.
			if (chosenModel === undefined) {
				if (matchesKey(data, Key.backspace)) {
					if (filter) {
						filter = filter.slice(0, -1);
						showModels();
					}
					return;
				}
				if (data.length === 1 && data >= " " && data !== "\x7f") {
					filter += data;
					showModels();
					return;
				}
			}
			list.handleInput(data);
		},
	};
}

export async function showConfigScreen(ctx: ExtensionContext, options: ScreenOptions): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The lobotomy screen needs the terminal UI; use /lobotomy set <task> <model> here.", "warning");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const config = options.config();
		const items: SettingItem[] = TASKS.map((task) => ({
			id: task.id,
			label: task.label,
			description: task.hint,
			currentValue: describeRoute(config.tasks[task.id]),
			submenu: (_current, submenuDone) => routeEditor(ctx, task.id, options.config().tasks[task.id], options.onRoute, submenuDone),
		}));
		items.push({
			id: TARGET_ROW,
			label: "Save to",
			description: "global: ~/.pi/agent/lobotomy.json · project: .pi/lobotomy.json",
			currentValue: options.target(),
			values: ["global", "project"],
		});
		items.push({
			id: RESET_ROW,
			label: "Reset all routes",
			description: "Enter clears every route in the chosen file",
			currentValue: "",
			values: ["", "done"],
		});

		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Lobotomy: one brain per task")), 1, 0));
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		container.addChild(new Text(theme.fg("muted", `session model: ${current} · inherit = the session model`), 1, 0));

		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 16),
			getSettingsListTheme(),
			(id, value) => {
				if (id === TARGET_ROW) {
					options.onTarget(value as SaveTarget);
				} else if (id === RESET_ROW) {
					options.onReset();
					for (const task of TASKS) list.updateValue(task.id, "inherit");
					list.updateValue(RESET_ROW, "");
				}
				tui.requestRender();
			},
			() => done(),
			{ enableSearch: false },
		);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ move · enter edit · esc close"), 1, 0));
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
