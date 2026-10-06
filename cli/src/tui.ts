/**
 * A small keyboard UI with no dependencies: a filterable list picker and a
 * text prompt, drawn in place with ANSI escapes.
 */
import { emitKeypressEvents } from "node:readline";

export interface Item {
	value: string;
	label: string;
	description?: string;
}

export interface PickOptions {
	initial?: string;
	/** Lets the person type a value that is not in the list (Enter with no match). */
	allowCustom?: boolean;
	maxVisible?: number;
}

const ESC = "\x1b[";
const out = process.stdout;

export const style = {
	bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
	dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
	accent: (s: string) => `${ESC}36m${s}${ESC}39m`,
	warn: (s: string) => `${ESC}33m${s}${ESC}39m`,
	inverse: (s: string) => `${ESC}7m${s}${ESC}27m`,
};

export function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

type Key = { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

interface Screen {
	draw: () => string[];
	onKey: (key: Key) => void;
}

/** Runs one screen in raw mode until it calls `finish`; redraws after every key. */
function withKeys<T>(run: (finish: (value: T) => void) => Screen): Promise<T> {
	return new Promise<T>((resolve) => {
		const stdin = process.stdin;
		emitKeypressEvents(stdin);
		stdin.setRawMode(true);
		stdin.resume();
		let drawn = 0;
		let finished = false;

		const clear = () => {
			if (drawn > 0) out.write(`${ESC}${drawn}A${ESC}J`);
			drawn = 0;
		};
		const finish = (value: T) => {
			if (finished) return;
			finished = true;
			clear();
			stdin.off("keypress", onKey);
			stdin.setRawMode(false);
			stdin.pause();
			resolve(value);
		};
		const screen = run(finish);
		const redraw = () => {
			clear();
			const lines = screen.draw();
			out.write(`${lines.join("\n")}\n`);
			drawn = lines.length;
		};
		const onKey = (_: string, key: Key) => {
			if (key.ctrl && key.name === "c") {
				finish(undefined as T);
				process.exit(130);
			}
			screen.onKey(key);
			if (!finished) redraw();
		};
		stdin.on("keypress", onKey);
		redraw();
	});
}

/** A list the arrows move through, typing filters, Enter picks, Esc cancels. */
export function pick(title: string, items: Item[], options: PickOptions = {}): Promise<string | undefined> {
	const maxVisible = options.maxVisible ?? 12;
	let filter = "";
	let index = Math.max(0, items.findIndex((item) => item.value === options.initial));

	const visible = () => {
		const needle = filter.toLowerCase();
		return needle ? items.filter((item) => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle)) : items;
	};

	return withKeys<string | undefined>((finish) => ({
		draw(): string[] {
				const list = visible();
				index = Math.min(index, Math.max(0, list.length - 1));
				const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), list.length - maxVisible));
				const rows = list.slice(start, start + maxVisible).map((item, i) => {
					const selected = start + i === index;
					const label = `${item.label}${item.description ? style.dim(`  ${item.description}`) : ""}`;
					return selected ? `${style.accent("❯")} ${style.accent(label)}` : `  ${label}`;
				});
				if (rows.length === 0) rows.push(style.dim(options.allowCustom ? "  no match; Enter uses what you typed" : "  no match"));
				const more = list.length > maxVisible ? style.dim(`  ${start + 1}-${Math.min(start + maxVisible, list.length)} of ${list.length}`) : "";
				const hint = filter ? `filter: ${filter}` : "type to filter · ↑↓ move · enter pick · esc back";
			return [style.bold(title), ...rows, ...(more ? [more] : []), style.dim(hint)];
		},
		onKey(key) {
			const list = visible();
			if (key.name === "up") index = index <= 0 ? Math.max(0, list.length - 1) : index - 1;
			else if (key.name === "down") index = index >= list.length - 1 ? 0 : index + 1;
			else if (key.name === "return") {
				const item = list[index];
				if (item) finish(item.value);
				else if (options.allowCustom && filter.trim()) finish(filter.trim());
			} else if (key.name === "escape") finish(undefined);
			else if (key.name === "backspace") filter = filter.slice(0, -1);
			else if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) {
				filter += key.sequence;
				index = 0;
			}
		},
	}));
}

/** One line of text; Enter submits, Esc cancels. */
export function ask(title: string, initial = ""): Promise<string | undefined> {
	let text = initial;
	return withKeys<string | undefined>((finish) => ({
		draw: () => [style.bold(title), `${style.accent("›")} ${text}${style.inverse(" ")}`, style.dim("enter submit · esc back")],
		onKey(key) {
			if (key.name === "return") finish(text.trim());
			else if (key.name === "escape") finish(undefined);
			else if (key.name === "backspace") text = text.slice(0, -1);
			else if (key.ctrl && key.name === "u") text = "";
			else if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) text += key.sequence;
		},
	}));
}
