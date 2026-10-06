# Lobotomy for pi

A pi package that routes each task to the model you choose. See the
repository README for the task list and configuration.

```
pi install /path/to/lobotomy/pi                       # every session
pi -e /path/to/lobotomy/pi/extensions/lobotomy/index.ts   # try it once
```

In a session: `/lobotomy` opens the config screen, `/lobotomy set quick
anthropic/claude-haiku-4-5 low` routes one task, `/quick`, `/plan`, `/review`
and `/commit` run on their routes. On pi 1.0 and newer, `/model lobotomy/auto`
switches to per-request routing through a virtual model.

Routes are stored in `~/.pi/agent/lobotomy.json` and `.pi/lobotomy.json`.
Files: `extensions/lobotomy/index.ts` (events, commands, virtual model),
`ui.ts` (the screen), `config.ts` (files), `routing.ts` (pure logic, tested
with `node --test`).
