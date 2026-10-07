import { describe, expect, test } from 'claude-code/testing'

import {
  describeConfig,
  gatewayFrom,
  gatewayHeaders,
  isModelName,
  parseModelList,
  parsePresets,
  shortName,
  uncatalogued,
  modelChoice,
  modelNames,
  withModel,
  normalizeConfig,
  parseCommand,
  resolveMain,
  resolveModel,
  resolveSpawn,
  taskForSkill,
  withRoute,
} from './routing'

const config = normalizeConfig({
  tasks: {
    main: { model: 'inherit', level: 'high' },
    plan: { model: 'opus' },
    quick: { model: 'haiku' },
    review: { model: 'sonnet', level: 'medium' },
    explore: { model: 'haiku' },
    subagent: { model: 'sonnet' },
    background: { model: 'haiku' },
    'agent:claude-code-guide': { model: 'claude-sonnet-5-5' },
    'skill:simplify': { model: 'fable' },
    junk: { model: 42 },
  },
})

describe('routing', () => {
  test('normalizeConfig keeps only well-formed routes', async () => {
    expect(config.tasks.junk).toBeUndefined()
    expect(config.tasks.main).toEqual({ level: 'high' })
    expect(config.tasks.plan).toEqual({ model: 'opus' })
  })

  test('main loop: turn task, then plan mode, then main', async () => {
    expect(resolveMain(config, {})).toEqual({ task: 'main', route: { level: 'high' } })
    expect(resolveMain(config, { mode: 'plan' })?.task).toBe('plan')
    expect(resolveMain(config, { turnTask: 'quick', mode: 'plan' })?.route.model).toBe('haiku')
    expect(resolveMain(config, { turnTask: 'commit' })?.task).toBe('main')
    expect(resolveMain({ tasks: {}, models: {} }, { turnTask: 'quick', mode: 'plan' })).toBeUndefined()
  })

  test('spawns: override, background, Explore, Plan, default; forks inherit', async () => {
    expect(resolveSpawn(config, { subagentType: 'claude-code-guide' })?.route.model).toBe('claude-sonnet-5-5')
    expect(resolveSpawn(config, { subagentType: 'general-purpose', background: true })?.task).toBe('background')
    expect(resolveSpawn(config, { subagentType: 'Explore' })?.task).toBe('explore')
    expect(resolveSpawn(config, { subagentType: 'Plan' })?.task).toBe('plan')
    expect(resolveSpawn(config, { subagentType: 'general-purpose' })?.task).toBe('subagent')
    expect(resolveSpawn(config, { subagentType: 'fork', fork: true })).toBeUndefined()
  })

  test('skills map to review and commit, with skill overrides first', async () => {
    expect(taskForSkill(config, 'code-review')).toBe('review')
    expect(taskForSkill(config, 'simplify')).toBe('skill:simplify')
    expect(taskForSkill(config, 'commit')).toBeUndefined()
    expect(taskForSkill(config, 'init')).toBeUndefined()
  })

  test('withRoute sets, merges and clears', async () => {
    let next = withRoute({ tasks: {}, models: {} }, 'plan', { model: 'opus' })
    expect(next.tasks.plan).toEqual({ model: 'opus' })
    next = withRoute(next, 'plan', { model: 'opus', level: 'max' })
    expect(next.tasks.plan).toEqual({ model: 'opus', level: 'max' })
    next = withRoute(next, 'plan', { model: 'inherit', level: 'default' })
    expect(next.tasks.plan).toBeUndefined()
  })

  test('parseCommand reads every form', async () => {
    expect(parseCommand('')).toEqual({ kind: 'pane' })
    expect(parseCommand('status')).toEqual({ kind: 'status' })
    expect(parseCommand('set plan opus high')).toEqual({ kind: 'set', key: 'plan', route: { model: 'opus', level: 'high' } })
    expect(parseCommand('plan opus')).toEqual({ kind: 'set', key: 'plan', route: { model: 'opus', level: undefined } })
    expect(parseCommand('set plan opus wrong').kind).toBe('error')
    expect(parseCommand('clear plan')).toEqual({ kind: 'clear', key: 'plan' })
    expect(parseCommand('reset')).toEqual({ kind: 'reset' })
  })

  test('resolveModel turns aliases into ids, honouring the environment', async () => {
    const env = (name: string) => (name === 'ANTHROPIC_DEFAULT_HAIKU_MODEL' ? 'claude-haiku-4-5-20251001' : undefined)
    expect(resolveModel('haiku', env)).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('sonnet[1m]', env)).toBe('claude-sonnet-5-5[1m]')
    expect(resolveModel('Opus', env)).toBe('claude-opus-5-5')
    expect(resolveModel('claude-opus-4-8', env)).toBe('claude-opus-4-8')
    expect(resolveModel('inherit', env)).toBe('inherit')
  })

  test('display helpers', async () => {
    expect(modelChoice(undefined)).toBe('inherit')
    expect(modelChoice('opus')).toBe('opus')
    expect(modelChoice('claude-sonnet-5-5')).toBe('custom')
    expect(describeConfig({ tasks: {}, models: {} })).toMatch(/nothing routed/)
    expect(describeConfig(config)).toMatch(/plan\s+opus/)
  })
})

describe('model catalog', () => {
  const base = normalizeConfig({ tasks: {}, models: { glm: 'glm-5p3-flash', 'bad name': 'x', haiku: 'not-allowed', k2: '  kimi-k2-latest ' } })

  test('normalizeConfig keeps well-formed catalog entries and trims ids', async () => {
    expect(base.models).toEqual({ glm: 'glm-5p3-flash', k2: 'kimi-k2-latest' })
  })

  test('catalog names resolve to ids before alias resolution', async () => {
    const env = () => undefined
    expect(resolveModel('glm', env, base.models)).toBe('glm-5p3-flash')
    expect(resolveModel('haiku', env, base.models)).toBe('claude-haiku-4-5')
    expect(resolveModel('accounts/fireworks/models/x', env, base.models)).toBe('accounts/fireworks/models/x')
  })

  test('the picker lists aliases, then catalog names; a routed catalog name is not custom', async () => {
    expect(modelNames(base)).toEqual(['inherit', 'haiku', 'sonnet', 'opus', 'fable', 'glm', 'k2'])
    expect(modelChoice('glm', base)).toBe('glm')
    expect(modelChoice('glm-5p3-flash', base)).toBe('custom')
  })

  test('withModel adds and removes; withRoute keeps the catalog', async () => {
    const added = withModel(base, 'ds', 'deepseek-flash-latest')
    expect(added.models.ds).toBe('deepseek-flash-latest')
    const routed = withRoute(added, 'explore', { model: 'ds' })
    expect(routed.models.ds).toBe('deepseek-flash-latest')
    expect(withModel(routed, 'ds', undefined).models.ds).toBeUndefined()
  })

  test('isModelName rejects aliases, custom, spaces and long names', async () => {
    expect(isModelName('glm')).toBe(true)
    expect(isModelName('haiku')).toBe(false)
    expect(isModelName('custom')).toBe(false)
    expect(isModelName('two words')).toBe(false)
    expect(isModelName('x'.repeat(30))).toBe(false)
  })

  test('parseCommand understands model add, model rm and models', async () => {
    expect(parseCommand('model add glm glm-5p3-flash')).toEqual({ kind: 'model-add', name: 'glm', id: 'glm-5p3-flash' })
    expect(parseCommand('model rm glm')).toEqual({ kind: 'model-rm', name: 'glm' })
    expect(parseCommand('models')).toEqual({ kind: 'models' })
    expect(parseCommand('model add haiku x').kind).toBe('error')
    expect(parseCommand('model add glm').kind).toBe('error')
  })

  test('describeConfig lists the catalog after the routes', async () => {
    const text = describeConfig(withRoute(base, 'explore', { model: 'glm' }))
    expect(text).toContain('explore            glm')
    expect(text).toContain('models:')
    expect(text).toContain('glm              glm-5p3-flash')
  })
})

describe('discovery', () => {
  test('gatewayFrom ignores Anthropic and keeps a path prefix', async () => {
    expect(gatewayFrom(undefined)).toBeUndefined()
    expect(gatewayFrom('https://api.anthropic.com')).toBeUndefined()
    expect(gatewayFrom('https://api.fireworks.ai/inference/')).toEqual({ origin: 'https://api.fireworks.ai/inference', host: 'api.fireworks.ai' })
    expect(gatewayFrom('http://localhost:11434')?.host).toBe('localhost:11434')
    expect(gatewayFrom('not a url')).toBeUndefined()
  })

  test('gatewayHeaders carries the session auth and custom headers', async () => {
    const env = (n: string) => ({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_CUSTOM_HEADERS: 'X-Fireworks-Api-Key: fw_1\nX-Other: v' } as Record<string, string>)[n]
    expect(gatewayHeaders(env)).toEqual({ authorization: 'Bearer tok', 'x-fireworks-api-key': 'fw_1', 'x-other': 'v' })
  })

  test('parseModelList reads OpenAI-style and Ollama-style bodies', async () => {
    expect(parseModelList('{"data":[{"id":"glm-5p3-flash"},{"id":"claude-opus-5-5"},{"id":"glm-5p3-flash"}]}')).toEqual(['claude-opus-5-5', 'glm-5p3-flash'])
    expect(parseModelList('{"models":[{"name":"qwen3:8b"}]}')).toEqual(['qwen3:8b'])
    expect(parseModelList('nope')).toEqual([])
  })

  test('shortName takes the last segment, sanitizes, and avoids collisions and aliases', async () => {
    expect(shortName('accounts/fireworks/models/glm-5p3-flash')).toBe('glm-5p3-flash')
    expect(shortName('qwen3:8b')).toBe('qwen3-8b')
    expect(shortName('haiku')).toBe('m-haiku')
    expect(shortName('x/glm', ['glm'])).toBe('glm-2')
  })

  test('parsePresets and uncatalogued', async () => {
    expect(parsePresets('glm=glm-5p3-flash; haiku=x; ds = deepseek-flash-latest ;junk')).toEqual([
      { name: 'glm', id: 'glm-5p3-flash' },
      { name: 'ds', id: 'deepseek-flash-latest' },
    ])
    const cfg = normalizeConfig({ tasks: {}, models: { glm: 'glm-5p3-flash' } })
    expect(uncatalogued(['claude-opus-5-5', 'glm-5p3-flash', 'minimax-m3'], cfg)).toEqual(['minimax-m3'])
  })

  test('parseCommand understands setup', async () => {
    expect(parseCommand('setup')).toEqual({ kind: 'setup', ids: null })
    expect(parseCommand('setup all')).toEqual({ kind: 'setup', ids: 'all' })
    expect(parseCommand('setup a b')).toEqual({ kind: 'setup', ids: ['a', 'b'] })
  })
})
