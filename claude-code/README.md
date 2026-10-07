# Lobotomy for Claude Code

A function-hooks plugin that routes each task to the model you choose. See
the repository README for the task list and configuration.

```
claude --plugin-dir /path/to/lobotomy/claude-code     # one session
claude plugin marketplace add /path/to/lobotomy       # then: claude plugin install lobotomy@lobotomy
```

In a session: `/lobotomy` opens the pane, `/lobotomy set plan opus high`
routes one task, `/quick <question>` asks on the quick route. Models from
other providers go through a gateway the session points at (Fireworks,
OpenRouter, LiteLLM, Ollama) and get a short name in the catalog:
`/lobotomy model add glm glm-5p3-flash`, then `/lobotomy set explore glm`.
The pane's **Models** section edits the same catalog.

Files: `hooks/register.tsx` (the hooks and the pane), `hooks/routing.ts`
(pure routing logic), `types/index.d.ts` (the state contract),
`hooks/*.test.ts` (run with `claude plugin test .`).
