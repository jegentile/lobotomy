import { describe, expect, test } from 'claude-code/testing'

import {
  describeConfig,
  modelChoice,
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
    expect(resolveMain({ tasks: {} }, { turnTask: 'quick', mode: 'plan' })).toBeUndefined()
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
    let next = withRoute({ tasks: {} }, 'plan', { model: 'opus' })
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
    expect(describeConfig({ tasks: {} })).toMatch(/nothing routed/)
    expect(describeConfig(config)).toMatch(/plan\s+opus/)
  })
})
