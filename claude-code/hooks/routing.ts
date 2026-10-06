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

export const EMPTY_CONFIG: LobotomyConfig = { tasks: {} }

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

/** `haiku` or `sonnet[1m]` → a full id, through the alias environment variables; anything else unchanged. */
export function resolveModel(model: string, env: (name: string) => string | undefined): string {
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
  return { tasks }
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
  return { tasks }
}

/** The Select value that shows `model`: an alias, `inherit`, or `custom`. */
export function modelChoice(model: string | undefined): string {
  if (!isRouted(model)) return 'inherit'
  return (MODEL_CHOICES as readonly string[]).includes(model) ? model : CUSTOM
}

/** One line per configured route, for `/lobotomy status`. */
export function describeConfig(config: LobotomyConfig): string {
  const keys = Object.keys(config.tasks)
  if (keys.length === 0) return 'nothing routed; every task uses the session model.'
  const order = new Map(TASKS.map((task, i) => [task.id, i] as const))
  keys.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
  return keys
    .map(key => {
      const route = config.tasks[key] ?? {}
      const level = isLevel(route.level) ? ` (effort ${route.level})` : ''
      return `${key.padEnd(18)} ${route.model ?? 'inherit'}${level}`
    })
    .join('\n')
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
  '/quick <question>         ask one question on the "quick" route',
  '',
  'tasks: ' + TASKS.map(t => t.id).join(', '),
  'overrides: agent:<type> (agent:Explore), skill:<name> (skill:code-review)',
  'models: haiku, sonnet, opus, fable, inherit, or a full model id',
  'effort: ' + LEVEL_CHOICES.join(', '),
].join('\n')
