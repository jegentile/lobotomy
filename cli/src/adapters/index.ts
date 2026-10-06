import { aider } from "./aider.ts";
import { continueCli } from "./continue.ts";
import { crush } from "./crush.ts";
import { goose } from "./goose.ts";
import { opencode } from "./opencode.ts";
import type { Adapter } from "./types.ts";

export const ADAPTERS: readonly Adapter[] = [opencode, goose, aider, continueCli, crush];
