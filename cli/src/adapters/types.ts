import type { Config, Route } from "../tasks.ts";

/** What one write to an agent's config did. */
export interface WriteResult {
	path: string;
	/** The keys set, one line each, for the summary. */
	changes: string[];
	/** Things the person should know (an unsupported task, a model id to check). */
	notes: string[];
}

export interface Adapter {
	/** Short name, also the `agents.<name>` override key. */
	name: string;
	/** One line for the menu. */
	description: string;
	/** The tasks this agent can honour. */
	tasks: readonly string[];
	/** Where this adapter writes by default. */
	target: (cwd: string) => string;
	/** The adapter's own notion of a model id (`provider/model`, litellm style, ...). */
	modelHint: string;
	/** Translates a `provider/model` route into the agent's spelling. */
	formatModel: (route: Route) => string;
	/** Writes the routes into the agent's config, merging with what is there. */
	write: (config: Config, options: { cwd: string; project?: boolean; dryRun?: boolean }) => WriteResult;
}
