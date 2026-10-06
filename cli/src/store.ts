/** The shared routes file: `~/.config/lobotomy/lobotomy.json` (XDG), or `$LOBOTOMY_CONFIG`. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type Config, EMPTY_CONFIG, normalizeConfig } from "./tasks.ts";

export function configPath(): string {
	if (process.env.LOBOTOMY_CONFIG) return process.env.LOBOTOMY_CONFIG;
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "lobotomy", "lobotomy.json");
}

export function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function loadConfig(): Config {
	try {
		return normalizeConfig(readJson(configPath()));
	} catch (error) {
		console.error(`lobotomy: could not read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
		return EMPTY_CONFIG;
	}
}

export function saveConfig(config: Config): void {
	writeJson(configPath(), config);
}
