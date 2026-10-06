# lobotomy CLI

One routes file, written into the config files of agents that have no plugin
system: Goose, Aider, Continue CLI and Crush (and OpenCode, as an alternative
to its plugin). Node 22.18 or newer.

```
cd cli && npm install && npm link    # installs the `lobotomy` command
lobotomy                             # picker
lobotomy set main anthropic/claude-sonnet-4-5 high
lobotomy apply [agent...] [--project] [--dry-run]
lobotomy agents                      # what each adapter honours and where it writes
```

Adapters live in `src/adapters/`, one file each, implementing `Adapter`
from `types.ts`: a task list, a target path, a provider respelling and a
`write` that merges into the existing file. `npm test` runs them against
temporary home directories.
