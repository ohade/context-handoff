// FIXTURE for the native failure observed 2026-11-02: a stored system notice
// was not painted in the normal terminal. Exercise the display row separately.
import { expect, mock, test } from 'claude-code/testing'
import { NEW, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TURN, worldOf } from './fixtures/world'

const answer = `Full response begins. ${'Preserve every word. '.repeat(160)} סוף response ends.`
const saved = (world: ReturnType<typeof worldOf>) => JSON.parse(world.files.get(`${STATE}/sessions/${NEW}.json`)!)

async function handoff($: any, on: any) {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 'work' })
  await $.turn.complete({ ...TURN, turnId: 'work', answer })
  await clock.advance(10)
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 'handoff' })
  await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  await $.turn.complete({ ...TURN, turnId: 'handoff', answer: 'Handoff ready.' })
  await clock.advance(6_010)
  return { world, clock }
}

test('the previous response has one full display row before the continuation seed', async ($, on) => {
  const order: string[] = []
  const placed: string[] = []
  // The kit has no native renderer beneath the plugin. Its default row is empty.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.place', (_$, e) => {
    placed.push(e.id)
    order.push('display')
    return { value: { isPlaced: true, requestId: e.id } }
  })
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event === 'prompt.submit' ? ($: any, e: any, next: any) => {
      if (e.origin?.kind === 'plugin' && !e.text.startsWith('/context-handoff:compact-crafter automatic-run ')) order.push('seed')
      return hook($, e, next)
    } : hook)) as typeof on
  const { world, clock } = await handoff($, wrapped)
  const replay = saved(world).responseReplay
  const ui = await $.ui.mount({
    plugin: 'context-handoff', surface: 'terminal', component: 'Placed',
    props: { plugin: 'context-handoff', id: `response-${replay.attemptId}` },
  })
  expect((await ui.find({ type: 'Text', text: answer }))?.text).toBe(answer)
  expect(placed).toEqual([`response-${replay.attemptId}`])
  expect(order).toEqual(['display', 'seed'])
  expect(replay.status).toBe('shown')
  const foreign = await $.ui.mount({
    plugin: 'context-handoff', surface: 'terminal', component: 'Placed',
    props: { plugin: 'other-plugin', id: `response-${replay.attemptId}` },
  })
  expect(await foreign.find({ type: 'Text', text: answer })).toBeUndefined()
  await $.session.start(SESSION_START)
  await clock.advance(10)
  expect(placed).toEqual([`response-${replay.attemptId}`])
})

test('an unavailable display is uncertain and is never claimed shown or retried', async ($, on) => {
  let attempts = 0
  on('ui.place', () => {
    attempts += 1
    return { value: { isPlaced: false, reason: 'injected: no attached surface' } }
  })
  const { world, clock } = await handoff($, on)
  expect(saved(world).responseReplay.status).toBe('attempted')
  expect(world.notes.some((row: any) => row.type === 'user' && row.content[0].text.includes('display is uncertain'))).toBe(true)
  await $.session.start(SESSION_START)
  await clock.advance(10)
  expect(attempts).toBe(1)
})
