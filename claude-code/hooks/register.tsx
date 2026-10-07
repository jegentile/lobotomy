/**
 * Lobotomy: one brain per task.
 *
 * Routes each kind of work Claude Code does to the model (and effort) the
 * person chose: the main loop's requests through `turn.step`, subagents
 * through `agent.spawn`, plugins' helper calls through `model.complete`, and
 * compaction through `session.compact`. `/lobotomy` opens a pane to edit the
 * routes; `/lobotomy set <task> <model> [effort]` edits one from the prompt.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { LobotomyConfig, LobotomyRoute } from '../types'
import {
  CUSTOM,
  EMPTY_CONFIG,
  HELP,
  LEVEL_CHOICES,
  TASKS,
  describeConfig,
  gatewayFrom,
  gatewayHeaders,
  isLevel,
  isModelName,
  isRouted,
  modelChoice,
  modelNames,
  normalizeConfig,
  parseCommand,
  parseModelList,
  parsePresets,
  resolveMain,
  resolveModel,
  resolveSpawn,
  routeFor,
  shortName,
  taskForSkill,
  uncatalogued,
  withModel,
  withRoute,
} from './routing'

const PANE = 'lobotomy'
const STORE_KEY = 'config'

const config = atom({ plugin: 'lobotomy', key: 'config' } as const, EMPTY_CONFIG)
const turnTask = atom({ plugin: 'lobotomy', key: 'turnTask' } as const, null)
const mode = atom({ plugin: 'lobotomy', key: 'mode' } as const, 'default')
const agentTypes = atom({ plugin: 'lobotomy', key: 'agentTypes' } as const, [])
const customFor = atom({ plugin: 'lobotomy', key: 'customFor' } as const, null)
const lastRoute = atom({ plugin: 'lobotomy', key: 'lastRoute' } as const, '')
const discovered = atom({ plugin: 'lobotomy', key: 'discovered' } as const, { host: '', ids: [] })
const SEEN_KEY = 'seen-models'
const SEEDED_KEY = 'seeded-presets'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A route's model as the engine accepts it: aliases become full ids. */
async function modelId($: EngineInterface, model: string): Promise<string> {
  const catalog = (await read($, config)).models
  const vars: Record<string, string | undefined> = {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    ANTHROPIC_DEFAULT_FABLE_MODEL: await $.env.get('ANTHROPIC_DEFAULT_FABLE_MODEL'),
  }
  return resolveModel(model, name => vars[name], catalog)
}

/** Writes a change to the config atom and persists it in the plugin's store. */
async function save($: EngineInterface, change: (c: LobotomyConfig) => LobotomyConfig): Promise<LobotomyConfig> {
  const next = await update($, config, change)
  await $.store.set(STORE_KEY, next)
  return next
}

function describeRoute(route: LobotomyRoute): string {
  const model = isRouted(route.model) ? route.model : 'inherit'
  return isLevel(route.level) ? `${model} @ ${route.level}` : model
}

/** Trims one transcript message to a few lines for the compaction prompt. */
function renderMessage(message: SessionMessage): string {
  const head = message.role === 'user' ? 'User' : 'Assistant'
  const parts: string[] = []
  const text = message.text.trim()
  if (text) parts.push(text.length > 4000 ? `${text.slice(0, 4000)}\n[... ${text.length - 4000} more characters]` : text)
  for (const use of message.toolUses ?? []) {
    const input = JSON.stringify(use.input)
    const result = typeof use.text === 'string' ? use.text.replace(/\s+/g, ' ').slice(0, 300) : ''
    parts.push(`[tool ${use.tool}${use.isError ? ' (error)' : ''}] ${input.slice(0, 300)}${result ? ` -> ${result}` : ''}`)
  }
  for (const result of message.toolResults ?? []) {
    if (typeof result.text === 'string' && result.text.trim()) {
      parts.push(`[tool result${result.isError ? ' (error)' : ''}] ${result.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
  return `${head}:\n${parts.join('\n')}`
}

/** Where the kept tail of a transcript begins: the last real user turn in the final third. */
function keepFrom(messages: readonly SessionMessage[]): number {
  const floor = Math.floor(messages.length * 0.7)
  for (let i = messages.length - 1; i >= floor; i--) {
    const message = messages[i]
    if (message && message.role === 'user' && !(message.toolResults && message.toolResults.length > 0)) return i
  }
  return messages.length
}

/** Lists what the session's gateway serves; empty when there is no gateway or it does not answer. */
async function discoverModels($: EngineInterface): Promise<{ host: string; ids: string[] }> {
  const gateway = gatewayFrom(await $.env.get('ANTHROPIC_BASE_URL'))
  if (!gateway) return { host: '', ids: [] }
  const vars: Record<string, string | undefined> = {
    ANTHROPIC_AUTH_TOKEN: await $.env.get('ANTHROPIC_AUTH_TOKEN'),
    ANTHROPIC_API_KEY: await $.env.get('ANTHROPIC_API_KEY'),
    ANTHROPIC_CUSTOM_HEADERS: await $.env.get('ANTHROPIC_CUSTOM_HEADERS'),
  }
  try {
    const r = await $.http.fetch(`${gateway.origin}/v1/models`, { headers: { accept: 'application/json', ...gatewayHeaders(name => vars[name]) } })
    return { host: gateway.host, ids: r.ok ? parseModelList(r.text) : [] }
  } catch {
    return { host: gateway.host, ids: [] }
  }
}

/** Adds `ids` to the catalog under generated names; returns the names given. */
async function adopt($: EngineInterface, ids: readonly string[]): Promise<Array<[string, string]>> {
  const given: Array<[string, string]> = []
  await save($, c => {
    let next = c
    for (const id of ids) {
      if (Object.values(next.models ?? {}).includes(id)) continue
      const name = shortName(id, Object.keys(next.models ?? {}))
      next = withModel(next, name, id)
      given.push([name, id])
    }
    return next
  })
  return given
}

export const register: Register = (on, options) => {
  const wantDiscovery = options.discover !== false
  const presets = parsePresets(String(options.presets ?? ''))

  on('session.start', async ($, e, next) => {
    const stored = normalizeConfig(await $.store.get(STORE_KEY))
    await update($, config, () => stored)
    await update($, turnTask, () => null)
    await $.command.register({
      name: 'lobotomy',
      description: 'Pick which model runs each task (main, plan, review, subagents, ...)',
      argumentHint: '[set <task> <model> [effort] | status | reset]',
    })
    await $.command.register({
      name: 'quick',
      description: 'Ask one question on the "quick" route (a cheap model)',
      argumentHint: '<question>',
    })
    if (wantDiscovery) {
      const found = await discoverModels($)
      await update($, discovered, () => found)
      if (found.ids.length > 0) {
        // Presets: seeded once, each only when the gateway actually lists its id.
        if (!(await $.store.get(SEEDED_KEY))) {
          const listed = new Set(found.ids)
          await save($, c => presets.filter(p => listed.has(p.id) && !c.models?.[p.name]).reduce((acc, p) => withModel(acc, p.name, p.id), c))
          await $.store.set(SEEDED_KEY, true)
        }
        const seen = new Set(((await $.store.get(SEEN_KEY)) as string[] | undefined) ?? [])
        const fresh = uncatalogued(found.ids, await read($, config)).filter(id => !seen.has(id))
        if (fresh.length > 0) $.ui.toast(`lobotomy: ${fresh.length} new model${fresh.length === 1 ? '' : 's'} at ${found.host}; /lobotomy setup to add them`)
        await $.store.set(SEEN_KEY, found.ids)
      }
    }
    return next(e)
  })

  // ---------------------------------------------------------------- commands

  on('command.run', { command: 'lobotomy' }, async ($, e) => {
    const command = parseCommand(e.args)
    switch (command.kind) {
      case 'pane': {
        const opened = await $.ui.open({ id: PANE, title: 'Lobotomy', focus: true, closeOnEscape: true, rows: 26 })
        return {
          text: opened.isPlaced
            ? 'Lobotomy pane opened. Tab moves between fields, Enter picks, Esc closes.'
            : `Lobotomy pane could not be placed (${opened.reason}). Use /lobotomy set <task> <model> instead.`,
        }
      }
      case 'status':
        return { text: describeConfig(await read($, config)) }
      case 'help':
        return { text: HELP }
      case 'reset':
        await save($, () => EMPTY_CONFIG)
        return { text: 'every route cleared; all tasks use the session model.' }
      case 'clear':
        await save($, c => withRoute(c, command.key, {}))
        return { text: `${command.key} routes to the session model again.` }
      case 'set': {
        await save($, c => withRoute(c, command.key, command.route))
        return { text: `${command.key} → ${describeRoute(command.route)}` }
      }
      case 'models': {
        const models = Object.entries((await read($, config)).models).sort(([a], [b]) => a.localeCompare(b))
        return {
          text: models.length
            ? models.map(([name, id]) => `${name.padEnd(16)} ${id}`).join('\n')
            : 'no catalog yet; /lobotomy model add <name> <id> names a model from any provider your gateway serves.',
        }
      }
      case 'model-add': {
        await save($, c => withModel(c, command.name, command.id))
        return { text: `model ${command.name} = ${command.id}; now /lobotomy set <task> ${command.name}` }
      }
      case 'setup': {
        const found = await read($, discovered)
        if (!found.host) return { text: 'no gateway: ANTHROPIC_BASE_URL points at Anthropic (or is unset), so there is nothing to discover. /lobotomy model add <name> <id> still works.' }
        const cfg = await read($, config)
        const candidates = uncatalogued(found.ids, cfg)
        if (command.ids === null) {
          if (candidates.length === 0) return { text: `${found.host} lists ${found.ids.length} models and the catalog already names every non-Claude one.` }
          const taken = Object.keys(cfg.models ?? {})
          const lines = candidates.map(id => `  ${shortName(id, taken).padEnd(26)} ${id}`)
          return { text: [`${found.host} serves ${candidates.length} model${candidates.length === 1 ? '' : 's'} not in the catalog:`, ...lines, '', '/lobotomy setup all   adds them under those names', '/lobotomy setup <id> [<id>…]   adds some'].join('\n') }
        }
        const wanted = command.ids === 'all' ? candidates : command.ids.filter(id => found.ids.includes(id))
        const missing = command.ids === 'all' ? [] : command.ids.filter(id => !found.ids.includes(id))
        const given = await adopt($, wanted)
        const lines = given.map(([name, id]) => `  ${name.padEnd(26)} ${id}`)
        if (missing.length) lines.push(`  (not served by ${found.host}: ${missing.join(', ')})`)
        return { text: given.length ? [`added ${given.length} to the catalog:`, ...lines, '', 'now /lobotomy set <task> <name>, or open /lobotomy'].join('\n') : lines.join('\n') || 'nothing to add.' }
      }
      case 'model-rm': {
        const had = (await read($, config)).models[command.name] !== undefined
        await save($, c => withModel(c, command.name, undefined))
        return { text: had ? `model ${command.name} removed (routes that named it now pass "${command.name}" through as-is)` : `no catalog entry "${command.name}"` }
      }
      case 'error':
        return { text: command.message }
    }
  })

  on('command.run', { command: 'quick' }, async ($, e) => {
    const question = e.args.trim()
    if (!question) return { text: 'Usage: /quick <question>' }
    const route = routeFor(await read($, config), 'quick')
    await update($, turnTask, () => 'quick')
    // A command's hook holds the turn, so the prompt is submitted just after it.
    $.clock.after(0, () => void $.prompt.submit({ text: question }))
    return { text: route ? `quick → ${describeRoute(route)}` : 'quick: no route set; using the session model (/lobotomy set quick haiku)' }
  })

  // ------------------------------------------------------- session tracking

  // The classic hooks carry the permission mode; plan mode routes to "plan".
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (typeof e.permission_mode === 'string') await update($, mode, () => e.permission_mode as string)
    return next(e)
  })
  on('classic.PostToolUse', async ($, e, next) => {
    if (typeof e.permission_mode === 'string' && e.agent_id === undefined) {
      await update($, mode, () => e.permission_mode as string)
    }
    return next(e)
  })

  // A skill's expansion assigns the rest of the turn to its task.
  on('skill.prompt', async ($, e, next) => {
    const task = taskForSkill(await read($, config), e.skill)
    if (task) await update($, turnTask, () => task)
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    await update($, agentTypes, list => (list.includes(e.agent) ? list : [...list, e.agent].sort()))
    return next(e)
  })

  // ---------------------------------------------------------------- routing

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const hit = resolveMain(await read($, config), { turnTask: await read($, turnTask), mode: await read($, mode) })
    if (!hit) return yield* next(e)
    const request = { ...e }
    if (isRouted(hit.route.model)) request.model = await modelId($, hit.route.model)
    if (isLevel(hit.route.level)) request.effort = hit.route.level as Effort
    const label = `${hit.task} → ${request.model}${isLevel(hit.route.level) ? ` @ ${hit.route.level}` : ''}`
    $.ui.status(`🧠 ${label}`)
    await update($, lastRoute, () => label)
    return yield* next(request)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnTask, () => null)
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const hit = resolveSpawn(await read($, config), e)
    if (!hit || !isRouted(hit.route.model)) return next(e)
    $.ui.notice(e.tool_use_id, `lobotomy: ${hit.task} → ${hit.route.model}`)
    return next({ ...e, model: await modelId($, hit.route.model) })
  })

  on('model.complete', async ($, e, next) => {
    const route = routeFor(await read($, config), 'helper')
    if (!route) return next(e)
    const request = { ...e }
    if (isRouted(route.model)) request.model = await modelId($, route.model)
    if (isLevel(route.level) && request.effort === undefined) request.effort = route.level as Effort
    return next(request)
  })

  // Experimental: summarize with the "compact" model instead of the engine's.
  on('session.compact', async ($, e, next) => {
    const route = routeFor(await read($, config), 'compact')
    if (!route || !isRouted(route.model) || e.messages.length < 6) return next(e)
    const cut = keepFrom(e.messages)
    const summarized = e.messages.slice(0, cut)
    if (summarized.length < 4) return next(e)
    let transcript = summarized.map(renderMessage).join('\n\n')
    if (transcript.length > 400_000) {
      transcript = `${transcript.slice(0, 200_000)}\n\n[... middle of the conversation omitted ...]\n\n${transcript.slice(-200_000)}`
    }
    const focus = e.instructions ? `\nPay particular attention to: ${e.instructions}\n` : ''
    const prompt = [
      'You are summarizing a coding session so that it can continue in a fresh context window.',
      'Write a structured summary with these sections: Goal, Decisions and why, Files read or changed (paths), Current state of the work, Open problems, Next steps.',
      'Keep exact identifiers, paths, commands and error text; drop pleasantries. Be complete but not verbose.',
      focus,
      '<conversation>',
      transcript,
      '</conversation>',
    ].join('\n')
    const reply = await $.model.complete(
      { model: await modelId($, route.model), prompt, maxTokens: 8000, ...(isLevel(route.level) ? { effort: route.level as Effort } : {}) },
      { signal: next.signal },
    )
    if (!reply.isAnswered || !reply.text.trim()) {
      $.ui.log(`lobotomy: compaction on ${route.model} failed (${reply.isAnswered ? 'empty reply' : reply.reason}); the engine compacts instead`)
      return next(e)
    }
    const summary: SessionMessage = {
      role: 'user',
      text: `This session is being continued from a conversation that ran out of context. Summary of what happened so far (written by ${route.model}):\n\n${reply.text.trim()}`,
      toolUses: [],
    }
    $.ui.log(`lobotomy: compacted ${summarized.length} messages with ${route.model}`)
    return { messages: [summary, ...e.messages.slice(cut)], usage: reply.usage }
  })

  // ------------------------------------------------------------------- pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>{"Lobotomy's pane needs a surface with pickers; use /lobotomy set <task> <model> here."}</Text>
    }
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const cfg = await read($, config)
    const types = await read($, agentTypes)
    const editing = await read($, customFor)
    const route = await read($, lastRoute)
    const found = await read($, discovered)
    const fresh = uncatalogued(found.ids, cfg)
    const session = await $.session.model()
    const wide = (e.props.bodyColumns ?? 80) >= 70

    const modelOptions = [...modelNames(cfg).map(value => ({ value })), { value: CUSTOM, label: 'custom…' }]
    const levelOptions = LEVEL_CHOICES.map(value => ({ value }))

    const pick = (key: string, field: 'model' | 'level') => (value: string) => {
      if (field === 'model' && value === CUSTOM) {
        void update($, customFor, () => key)
        return
      }
      void (async () => {
        await save($, c => withRoute(c, key, { ...(c.tasks[key] ?? {}), [field]: value }))
        if (field === 'model') await update($, customFor, current => (current === key ? null : current))
      })()
    }

    const row = (key: string, label: string, hint: string) => {
      const current = cfg.tasks[key] ?? {}
      const choice = modelChoice(current.model, cfg)
      const routed = isRouted(current.model) || isLevel(current.level)
      return (
        <Box key={`row-${key}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box width={12}>
              <Text color={routed ? 'text' : undefined} dimColor={!routed}>
                {label}
              </Text>
            </Box>
            <Select key={`model:${key}`} options={modelOptions} value={choice} onSelect={pick(key, 'model')} />
            <Select key={`level:${key}`} label="effort" options={levelOptions} value={isLevel(current.level) ? current.level : 'default'} onSelect={pick(key, 'level')} />
            {choice === CUSTOM && editing !== key && <Text color="suggestion">{current.model}</Text>}
          </Box>
          {editing === key && (
            <Box flexDirection="row" gap={1} paddingLeft={13}>
              <Input
                key={`custom:${key}`}
                label="model id"
                placeholder="claude-…"
                value={choice === CUSTOM ? current.model : ''}
                autoFocus
                onSubmit={(value: string) => {
                  const model = value.trim()
                  void (async () => {
                    if (model) await save($, c => withRoute(c, key, { ...(c.tasks[key] ?? {}), model }))
                    await update($, customFor, () => null)
                  })()
                }}
              />
            </Box>
          )}
          {wide && (
            <Box paddingLeft={13}>
              <Text dimColor>{hint}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const overrides = types.filter(type => type !== 'Explore' && type !== 'Plan')
    const routedCount = Object.keys(cfg.tasks).length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>
            ⏺
          </Text>
          <Text bold>Lobotomy</Text>
          <Text dimColor>one brain per task</Text>
        </Box>
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>
            session model <Text color="text">{session}</Text> · {routedCount === 0 ? 'nothing routed yet' : `${routedCount} route${routedCount === 1 ? '' : 's'}`}
            {route ? ' · last: ' : ''}
            {route ? <Text color="success">{route}</Text> : null}
          </Text>
        </Box>
        <Text> </Text>
        <Text color="permission" bold>
          Tasks
        </Text>
        {TASKS.map(task => row(task.id, task.label, task.hint))}
        {overrides.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text color="permission" bold>
              Agent overrides
            </Text>
            {overrides.map(type => row(`agent:${type}`, type.slice(0, 12), `the ${type} agent`))}
          </Box>
        )}
        <Text> </Text>
        <Text color="permission" bold>
          Models
        </Text>
        {Object.entries(cfg.models)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, id]) => (
            <Box key={`model-${name}`} flexDirection="row" gap={1}>
              <Box width={12}>
                <Text>{name}</Text>
              </Box>
              <Text dimColor>{id}</Text>
              <Button key={`rm:${name}`} onPress={() => void save($, c => withModel(c, name, undefined))}>
                remove
              </Button>
            </Box>
          ))}
        <Box flexDirection="row" gap={1}>
          <Input
            key="model-add"
            label="add"
            placeholder="name = model-id   (glm = glm-5p3-flash)"
            value=""
            onSubmit={(value: string) => {
              const m = /^\s*([^\s=]+)\s*=\s*(\S+)\s*$/.exec(value) ?? /^\s*(\S+)\s+(\S+)\s*$/.exec(value)
              if (!m || !isModelName(m[1] ?? '')) return
              void save($, c => withModel(c, m[1] as string, m[2] as string))
            }}
          />
        </Box>
        {wide && (
          <Box paddingLeft={2}>
            <Text dimColor>names for models from any provider the session's gateway serves; they appear in every picker above</Text>
          </Box>
        )}
        {fresh.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text color="permission" bold>
              New at {found.host}
            </Text>
            {fresh.slice(0, 12).map(id => (
              <Box key={`new-${id}`} flexDirection="row" gap={1}>
                <Text dimColor>{id}</Text>
                <Button key={`add:${id}`} onPress={() => void adopt($, [id])}>
                  add
                </Button>
              </Box>
            ))}
            <Box flexDirection="row" gap={1}>
              {fresh.length > 12 && <Text dimColor>and {fresh.length - 12} more</Text>}
              <Button key="add-all" hotkey="a" onPress={() => void adopt($, fresh)}>
                Add all {fresh.length}
              </Button>
            </Box>
          </Box>
        )}
        <Text> </Text>
        <Box flexDirection="row" gap={2}>
          <Button key="reset" hotkey="r" onPress={() => void save($, () => EMPTY_CONFIG)}>
            Reset all
          </Button>
          <Button key="close" hotkey="q" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
        <Text dimColor>inherit keeps the session model · default keeps the model's own effort</Text>
        <Text dimColor>Tab to move · Enter to select · Esc to close</Text>
      </Box>
    )
  })
}
