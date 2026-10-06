# Lobotomy for OpenCode

A server plugin that applies the shared routes file
(`~/.config/lobotomy/lobotomy.json`, written by the `lobotomy` CLI or by the
plugin's own `lobotomy` tool) to OpenCode.

```
mkdir -p ~/.config/opencode/plugins
ln -s /path/to/lobotomy/opencode/lobotomy.ts ~/.config/opencode/plugins/lobotomy.ts
```

Per project, link it into `.opencode/plugins/` instead.

| Task | Where it lands |
| --- | --- |
| `main` | the `build` agent; also set on every build message as it arrives |
| `plan` | the `plan` agent; also set on every plan message as it arrives |
| `quick`, `review`, `commit` | `/quick`, `/review`, `/commit` commands with that model |
| `subagent` | the `general` agent |
| `explore` | the `explore` agent |
| `compact` | the `compaction`, `title` and `summary` agents, and `small_model` |

The `lobotomy` tool lets you say "route planning to anthropic/claude-haiku-4-5"
in chat; `/lobotomy` lists the active routes. Changes to `main` and `plan`
apply on the next message; the rest apply when OpenCode restarts.
