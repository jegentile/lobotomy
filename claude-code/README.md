# Lobotomy for Claude Code

A function-hooks plugin that routes each task to the model you choose. See
the repository README for the task list and configuration.

```
claude --plugin-dir /path/to/lobotomy/claude-code     # one session
claude plugin marketplace add /path/to/lobotomy       # then: claude plugin install lobotomy@lobotomy
```

In a session: `/lobotomy` opens the pane, `/lobotomy set plan opus high`
routes one task, `/quick <question>` asks on the quick route.

Files: `hooks/register.tsx` (the hooks and the pane), `hooks/routing.ts`
(pure routing logic), `types/index.d.ts` (the state contract),
`hooks/*.test.ts` (run with `claude plugin test .`).
