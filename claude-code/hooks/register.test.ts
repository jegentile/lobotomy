import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Stored = Readonly<Record<string, unknown>>

const ROUTES: Stored = {
  config: {
    tasks: {
      plan: { model: 'opus', level: 'high' },
      quick: { model: 'haiku' },
      explore: { model: 'haiku' },
      subagent: { model: 'sonnet' },
      review: { model: 'sonnet' },
    },
  },
}

const EMPTY: Stored = { config: { tasks: {}, models: {} } }

/**
 * The engine beneath the plugin: what `session.start` and the hooks call.
 * Returns the store's last written config, for the assertions.
 */
function world(on: On, stored: Stored) {
  const store = new Map(Object.entries(stored))
  const written: { config?: unknown } = {}
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    if (e.key === 'config') written.config = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'ANTHROPIC_DEFAULT_OPUS_MODEL' ? 'claude-opus-4-8' : undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.notice', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return written
}

/** Reads a streaming call to its end, so the chain beneath runs, and answers its result. */
async function drain<R>(stream: AsyncGenerator<unknown, R> & { readonly result: Promise<R> }): Promise<R> {
  for await (const _chunk of stream) {
    // chunks are not under test
  }
  return stream.result
}

const SESSION = { cwd: '/tmp/x', surface: 'terminal' as const, isInteractive: true }
const COMPOSER = { origin: { kind: 'composer' as const }, presentation: { surface: 'main' as const, columns: 80, isFullscreen: false } }

test('subagent spawns are routed by type, forks are left alone', async ($, on) => {
  world(on, ROUTES)
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => {
    seen.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: 'a1' }
  })
  await $.session.start(SESSION)
  const base = {
    tool_use_id: 't1',
    prompt: 'look around',
    description: 'look',
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-fable-5-1',
    background: false,
    fork: false,
  }
  await $.agent.spawn({ ...base, subagentType: 'Explore' })
  await $.agent.spawn({ ...base, subagentType: 'general-purpose' })
  await $.agent.spawn({ ...base, subagentType: 'fork', fork: true })
  expect(seen).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5', undefined])
})

test('main requests use the plan route in plan mode and the quick route after /quick', async ($, on) => {
  world(on, ROUTES)
  const requests: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_$, e) {
    requests.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start(SESSION)

  const step = () => drain($.turn.step({ turnId: 'turn', index: 0, model: 'claude-fable-5-1', messageCount: 1 }))

  await step()
  await $.classic.UserPromptSubmit({ prompt: 'plan it', permission_mode: 'plan' })
  await step()
  await $.classic.UserPromptSubmit({ prompt: 'now build', permission_mode: 'default' })
  await $.command.run({ command: 'quick', args: 'what is 2+2', ...COMPOSER })
  await step()
  await $.turn.complete({ turnId: 'turn', answer: 'done', durationMs: 10, isAborted: false } as never)
  await step()

  expect(requests.map(r => r.model)).toEqual(['claude-fable-5-1', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5-1'])
  expect(requests[1]?.effort).toBe('high')
})

test('a review skill routes the rest of the turn', async ($, on) => {
  world(on, ROUTES)
  const models: string[] = []
  on('turn.step', async function* (_$, e) {
    models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  await $.session.start(SESSION)
  await $.skill.prompt({ skill: 'code-review', text: 'review the diff' })
  await drain($.turn.step({ turnId: 't', index: 1, model: 'claude-fable-5-1', messageCount: 3 }))
  expect(models).toEqual(['claude-sonnet-5-5'])
})

test('/lobotomy set and clear persist to the store', async ($, on) => {
  const written = world(on, EMPTY)
  await $.session.start(SESSION)
  const run = (args: string) => $.command.run({ command: 'lobotomy', args, ...COMPOSER })
  expect((await run('set plan opus high')).text).toMatch(/plan → opus @ high/)
  expect(written.config).toEqual({ tasks: { plan: { model: 'opus', level: 'high' } }, models: {} })
  expect((await run('status')).text).toMatch(/plan\s+opus/)
  await run('clear plan')
  expect(written.config).toEqual({ tasks: {}, models: {} })
})

test('the pane picks a model per task on every surface with pickers', async ($, on) => {
  const written = world(on, EMPTY)
  await $.session.start(SESSION)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'lobotomy',
      surface,
      component: 'Pane',
      requestId: 'lobotomy',
      props: { title: 'Lobotomy', isFocused: true, bodyColumns: 100, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /one brain per task/ })).toBeDefined()
    await ui.select({ key: 'model:plan', value: 'opus' })
    await ui.select({ key: 'level:plan', value: 'xhigh' })
    expect(written.config).toEqual({ tasks: { plan: { model: 'opus', level: 'xhigh' } }, models: {} })
    await ui.select({ key: 'model:quick', value: 'custom' })
    await ui.input({ key: 'custom:quick', text: 'claude-haiku-4-5' })
    expect(written.config).toMatchObject({ tasks: { quick: { model: 'claude-haiku-4-5' } } })
    await ui.press({ key: 'reset' })
    expect(written.config).toEqual({ tasks: {}, models: {} })
    await ui.unmount()
  }
})
