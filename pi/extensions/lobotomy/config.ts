/**
 * Where the routes live: `~/.pi/agent/lobotomy.json` for every project and
 * `<project>/.pi/lobotomy.json` for one, merged with the project winning.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { type Config, EMPTY_CONFIG, mergeConfigs, normalizeConfig } from "./routing.ts";

export const FILE_NAME = "lobotomy.json";

export function globalPath(): string {
	return join(getAgentDir(), FILE_NAME);
}

export function projectPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, FILE_NAME);
}

export function readConfigFile(path: string): Config {
	if (!existsSync(path)) return EMPTY_CONFIG;
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		console.error(`lobotomy: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return EMPTY_CONFIG;
	}
}

export function writeConfigFile(path: string, config: Config): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** The effective routes: global, then the project's on top (when trusted). */
export function loadConfig(cwd: string, projectTrusted: boolean): Config {
	const global = readConfigFile(globalPath());
	if (!projectTrusted) return global;
	return mergeConfigs(global, readConfigFile(projectPath(cwd)));
}
