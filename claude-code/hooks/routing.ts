/**
 * Pure routing logic: no engine, no I/O. The hooks module and the tests both
 * import from here.
 */
import type { LobotomyConfig, LobotomyRoute } from '../types'

export type Task = {
  id: string
  label: string
  /** One line: when this route is used. */
  hint: string
}

/** The tasks a person assigns a brain to, in the order the pane lists them. */
export const TASKS: readonly Task[] = [
  { id: 'main', label: 'Main', hint: 'the main conversation' },
  { id: 'plan', label: 'Plan', hint: 'plan mode, and the Plan agent' },
  { id: 'quick', label: 'Quick', hint: '/quick <question>: cheap one-off answers' },
  { id: 'review', label: 'Review', hint: '/code-review, /security-review, /simplify' },
  { id: 'commit', label: 'Commit', hint: 'commit and PR text skills' },
  { id: 'explore', label: 'Explore', hint: 'the Explore agent (codebase search)' },
  { id: 'subagent', label: 'Subagents', hint: 'every other Agent spawn' },
  { id: 'background', label: 'Background', hint: 'subagents run in the background' },
  { id: 'compact', label: 'Compact', hint: 'context compaction summaries (experimental)' },
  { id: 'helper', label: 'Helpers', hint: "plugins' own model calls (classify, complete)" },
]

export const MODEL_CHOICES = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'] as const
export const LEVEL_CHOICES = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const CUSTOM = 'custom'

export const EMPTY_CONFIG: LobotomyConfig = { tasks: {}, models: {} }

/**
 * What each alias means when no `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` variable
 * says otherwise. The main loop's requests need full ids: the engine refuses
 * an alias there (`unrecognized_model`), while the Agent tool resolves one.
 */
export const ALIAS_DEFAULTS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

/**
 * A route's model as the API wants it. A catalog name (`glm`) becomes the id
 * it stands for; `haiku` or `sonnet[1m]` becomes a full id through the alias
 * environment variables; anything else is already an id and passes unchanged.
 */
export function resolveModel(model: string, env: (name: string) => string | undefined, catalog: Record<string, string> = {}): string {
  const named = catalog[model.trim()]
  if (named) return named
  const match = /^([a-z]+)(\[1m\])?$/i.exec(model.trim())
  if (!match) return model
  const alias = (match[1] ?? '').toLowerCase()
  const base = ALIAS_DEFAULTS[alias]
  if (!base) return model
  const configured = env(`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`)
  return `${configured && configured.trim() ? configured.trim() : base}${match[2] ?? ''}`
}

/** Which skills belong to which task, by exact name. `skill:<name>` overrides win. */
const SKILL_TASKS: Record<string, string> = {
  'code-review': 'review',
  'security-review': 'review',
  simplify: 'review',
  review: 'review',
  commit: 'commit',
  'commit-push-pr': 'commit',
  'commit-and-push': 'commit',
  pr: 'commit',
}

/** True when `model` names an actual model rather than "leave it alone". */
export function isRouted(model: string | undefined): model is string {
  return typeof model === 'string' && model !== '' && model !== 'inherit' && model !== 'default'
}

export function isLevel(level: string | undefined): level is string {
  return typeof level === 'string' && level !== '' && level !== 'default'
}

/** The route for `key`, or undefined when it routes nothing. */
export function routeFor(config: LobotomyConfig, key: string): LobotomyRoute | undefined {
  const route = config.tasks[key]
  if (!route) return undefined
  if (!isRouted(route.model) && !isLevel(route.level)) return undefined
  return route
}

export type Resolved = { task: string; route: LobotomyRoute }

/**
 * The route for a request of the main loop: the turn's task when one was
 * assigned and routes, else plan mode's, else main's.
 */
export function resolveMain(
  config: LobotomyConfig,
  ctx: { turnTask?: string | null; mode?: string },
): Resolved | undefined {
  const candidates: string[] = []
  if (ctx.turnTask) candidates.push(ctx.turnTask)
  if (ctx.mode === 'plan') candidates.push('plan')
  candidates.push('main')
  for (const task of candidates) {
    const route = routeFor(config, task)
    if (route) return { task, route }
  }
  return undefined
}

/**
 * The route for a subagent about to spawn. A fork always inherits. Order:
 * `agent:<type>` override, background, Explore, Plan, then the subagent default.
 */
export function resolveSpawn(
  config: LobotomyConfig,
  spawn: { subagentType: string; background?: boolean; fork?: boolean },
): Resolved | undefined {
  if (spawn.fork) return undefined
  const type = spawn.subagentType
  const candidates = [`agent:${type}`]
  if (spawn.background) candidates.push('background')
  if (type === 'Explore') candidates.push('explore')
  if (type === 'Plan') candidates.push('plan')
  candidates.push('subagent')
  for (const task of candidates) {
    const route = routeFor(config, task)
    if (route) return { task, route }
  }
  return undefined
}

/** The task a skill's expansion assigns to the turn, when any routes. */
export function taskForSkill(config: LobotomyConfig, skill: string): string | undefined {
  const override = `skill:${skill}`
  if (routeFor(config, override)) return override
  const task = SKILL_TASKS[skill]
  if (task && routeFor(config, task)) return task
  return undefined
}

/** A copy of `config` with `key` set to `route`, or removed when it routes nothing. */
export function withRoute(config: LobotomyConfig, key: string, route: LobotomyRoute): LobotomyConfig {
  const tasks = { ...config.tasks }
  const next: LobotomyRoute = {}
  if (isRouted(route.model)) next.model = route.model
  if (isLevel(route.level)) next.level = route.level
  if (next.model === undefined && next.level === undefined) delete tasks[key]
  else tasks[key] = next
  return { ...config, tasks }
}

/** A valid catalog name: short, no spaces, not an alias the picker already has. */
export function isModelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,23}$/i.test(name) && !(MODEL_CHOICES as readonly string[]).includes(name) && name !== CUSTOM
}

/** A copy of `config` with catalog entry `name` set to `id`, or removed when `id` is undefined. */
export function withModel(config: LobotomyConfig, name: string, id: string | undefined): LobotomyConfig {
  const models = { ...(config.models ?? {}) }
  if (id === undefined) delete models[name]
  else models[name] = id
  return { ...config, models }
}

/** The names the picker offers: the aliases, then the catalog, then `custom`. */
export function modelNames(config: LobotomyConfig): string[] {
  return [...MODEL_CHOICES, ...Object.keys(config.models ?? {}).sort()]
}

/** Reads a stored value back into a config, dropping anything malformed. */
export function normalizeConfig(value: unknown): LobotomyConfig {
  const tasks: Record<string, LobotomyRoute> = {}
  const raw = (value as { tasks?: unknown } | undefined)?.tasks
  if (raw && typeof raw === 'object') {
    for (const [key, route] of Object.entries(raw as Record<string, unknown>)) {
      if (!route || typeof route !== 'object') continue
      const { model, level } = route as { model?: unknown; level?: unknown }
      const clean: LobotomyRoute = {}
      if (typeof model === 'string' && isRouted(model)) clean.model = model
      if (typeof level === 'string' && isLevel(level)) clean.level = level
      if (clean.model !== undefined || clean.level !== undefined) tasks[key] = clean
    }
  }
  const models: Record<string, string> = {}
  const rawModels = (value as { models?: unknown } | undefined)?.models
  if (rawModels && typeof rawModels === 'object') {
    for (const [name, id] of Object.entries(rawModels as Record<string, unknown>)) {
      if (typeof id === 'string' && id.trim() && isModelName(name)) models[name] = id.trim()
    }
  }
  return { tasks, models }
}

/** The Select value that shows `model`: an alias, a catalog name, `inherit`, or `custom`. */
export function modelChoice(model: string | undefined, config: LobotomyConfig = EMPTY_CONFIG): string {
  if (!isRouted(model)) return 'inherit'
  return modelNames(config).includes(model) ? model : CUSTOM
}

/** One line per configured route, for `/lobotomy status`. */
export function describeConfig(config: LobotomyConfig): string {
  const keys = Object.keys(config.tasks)
  const catalog = Object.entries(config.models ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const models = catalog.length ? '\n\nmodels:\n' + catalog.map(([name, id]) => `  ${name.padEnd(16)} ${id}`).join('\n') : ''
  if (keys.length === 0) return 'nothing routed; every task uses the session model.' + models
  const order = new Map(TASKS.map((task, i) => [task.id, i] as const))
  keys.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
  return keys
    .map(key => {
      const route = config.tasks[key] ?? {}
      const level = isLevel(route.level) ? ` (effort ${route.level})` : ''
      return `${key.padEnd(18)} ${route.model ?? 'inherit'}${level}`
    })
    .join('\n') + models
}

/**
 * Parses `/lobotomy` arguments: `set <task> <model> [level]`, `clear <task>`,
 * `reset`, `status`, `help`, or nothing (the pane).
 */
export type Command =
  | { kind: 'pane' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'reset' }
  | { kind: 'clear'; key: string }
  | { kind: 'set'; key: string; route: LobotomyRoute }
  | { kind: 'models' }
  | { kind: 'model-add'; name: string; id: string }
  | { kind: 'model-rm'; name: string }
  | { kind: 'setup'; ids: string[] | 'all' | null }
  | { kind: 'error'; message: string }

export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [verb, key, model, level] = words
  if (!verb) return { kind: 'pane' }
  switch (verb) {
    case 'status':
    case 'list':
      return { kind: 'status' }
    case 'help':
      return { kind: 'help' }
    case 'reset':
      return { kind: 'reset' }
    case 'clear':
      return key ? { kind: 'clear', key } : { kind: 'error', message: 'clear needs a task: /lobotomy clear plan' }
    case 'models':
      return { kind: 'models' }
    case 'setup': {
      const rest = words.slice(1)
      if (rest.length === 0) return { kind: 'setup', ids: null }
      if (rest.length === 1 && rest[0] === 'all') return { kind: 'setup', ids: 'all' }
      return { kind: 'setup', ids: rest }
    }
    case 'model': {
      // model add <name> <id> | model rm <name>
      const [, action, name, id] = words
      if (action === 'add') {
        if (!name || !id) return { kind: 'error', message: 'model add needs a name and an id: /lobotomy model add glm glm-5p3-flash' }
        if (!isModelName(name)) return { kind: 'error', message: `"${name}" is not a usable name (letters, digits, . _ -; not an alias)` }
        return { kind: 'model-add', name, id }
      }
      if (action === 'rm' || action === 'remove') {
        return name ? { kind: 'model-rm', name } : { kind: 'error', message: 'model rm needs a name: /lobotomy model rm glm' }
      }
      return { kind: 'error', message: 'model add <name> <id> | model rm <name> | models' }
    }
    case 'set': {
      if (!key || !model) return { kind: 'error', message: 'set needs a task and a model: /lobotomy set plan opus [high]' }
      if (level && !(LEVEL_CHOICES as readonly string[]).includes(level)) {
        return { kind: 'error', message: `unknown effort "${level}"; one of ${LEVEL_CHOICES.join(', ')}` }
      }
      return { kind: 'set', key, route: { model, level } }
    }
    default:
      // `/lobotomy plan opus` reads as a set.
      if (words.length >= 2) return parseCommand(`set ${args}`)
      return { kind: 'error', message: `unknown subcommand "${verb}"; try /lobotomy help` }
  }
}

export const HELP = [
  '/lobotomy                 open the config pane',
  '/lobotomy status          list the routes',
  '/lobotomy set <task> <model> [effort]',
  '/lobotomy clear <task>    route the task to the session model again',
  '/lobotomy reset           clear every route',
  '/lobotomy setup [all|<id>…]   add models the gateway serves to the catalog',
  '/lobotomy models          list the model catalog',
  '/lobotomy model add <name> <id>   name a model from any provider (glm = glm-5p3-flash)',
  '/lobotomy model rm <name>',
  '/quick <question>         ask one question on the "quick" route',
  '',
  'tasks: ' + TASKS.map(t => t.id).join(', '),
  'overrides: agent:<type> (agent:Explore), skill:<name> (skill:code-review)',
  'models: haiku, sonnet, opus, fable, inherit, a catalog name, or a full model id',
  'providers: point ANTHROPIC_BASE_URL at a gateway that serves them (Fireworks, OpenRouter, LiteLLM), then add names here',
  'effort: ' + LEVEL_CHOICES.join(', '),
].join('\n')

// ------------------------------------------------------------ discovery

/** The gateway a session talks to, or undefined for Anthropic itself (nothing to discover there). */
export function gatewayFrom(baseUrl: string | undefined): { origin: string; host: string } | undefined {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (/(^|\.)anthropic\.com$/i.test(url.hostname)) return undefined
    const path = url.pathname.replace(/\/+$/, '')
    return { origin: `${url.origin}${path}`, host: url.host }
  } catch {
    return undefined
  }
}

/** The headers a gateway request carries, from the same variables the session itself uses. */
export function gatewayHeaders(env: (name: string) => string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = env('ANTHROPIC_AUTH_TOKEN')?.trim()
  if (token) headers.authorization = `Bearer ${token}`
  const key = env('ANTHROPIC_API_KEY')?.trim()
  if (key) headers['x-api-key'] = key
  for (const line of (env('ANTHROPIC_CUSTOM_HEADERS') ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return headers
}

/** Model ids from a `/v1/models` body: `{ data: [{ id }] }` (Anthropic, OpenAI-style, LiteLLM, Ollama) or `{ models: [{ name }] }` (Ollama's own). */
export function parseModelList(text: string): string[] {
  try {
    const body = JSON.parse(text) as { data?: unknown; models?: unknown }
    const rows = (Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []) as Array<Record<string, unknown>>
    const ids = rows.map(r => (typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : '')).filter(Boolean)
    return [...new Set(ids)].sort()
  } catch {
    return []
  }
}

/** A catalog name for a model id: the last path segment, cut to what `isModelName` takes. */
export function shortName(id: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  let base = (id.split('/').pop() ?? id).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'model'
  if (!isModelName(base)) base = `m-${base}`.slice(0, 24)
  let name = base
  for (let n = 2; used.has(name) || !isModelName(name); n += 1) name = `${base.slice(0, 21)}-${n}`
  return name
}

/** `name=id; name=id` → entries, dropping malformed ones. */
export function parsePresets(text: string): Array<{ name: string; id: string }> {
  const out: Array<{ name: string; id: string }> = []
  for (const raw of text.split(/[;\n]/)) {
    const i = raw.indexOf('=')
    if (i < 0) continue
    const name = raw.slice(0, i).trim()
    const id = raw.slice(i + 1).trim()
    if (name && id && isModelName(name)) out.push({ name, id })
  }
  return out
}

/** True when the gateway lists `id` exactly or as the last segment of a path id (`glm-5p3-flash` ≈ `accounts/fireworks/models/glm-5p3-flash`). */
export function listed(id: string, discovered: readonly string[]): boolean {
  return discovered.some(d => d === id || d.endsWith('/' + id))
}

/** Ids the gateway serves that the catalog does not name and that count as Claude's own tiers nowhere. */
export function uncatalogued(discovered: readonly string[], config: LobotomyConfig): string[] {
  const known = new Set(Object.values(config.models ?? {}))
  return discovered.filter(id => !known.has(id) && !/^claude-/i.test(id))
}