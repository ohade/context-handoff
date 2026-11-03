// FIXTURE: delivery receipts survive completion; uncertainty never creates a retry draft.
import { expect, mock, test } from 'claude-code/testing'
import { seedText } from '../hooks/brief'
import { briefOf, logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TURN, worldOf } from './fixtures/world'

async function ready($: any, world: any, clock: any) {
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(10)
}

test('a completed observed seed turn still reconciles a later submit exception', async ($, on) => {
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event !== 'prompt.submit' ? hook : async ($: any, e: any, next: any) => {
      if (e.origin?.kind === 'plugin' && !e.text.startsWith('/context-handoff:compact-crafter automatic-run ')) { started(); await blocked }
      return hook($, e, next)
    })) as typeof on
  const world = worldOf(wrapped)
  world.failing.add('prompt.submit')
  const clock = mock.clock(on)
  await ready($, world, clock)
  await clock.advance(6_000)
  await entered
  const text = seedText(briefOf(world)!.path.split('/').pop()!)
  await $.turn.start({ turnId: 'seed-turn', text })
  await $.turn.complete({ ...TURN, turnId: 'seed-turn' })
  release()
  await clock.settle()
  expect(world.fills).toEqual([])
  expect(logOf(world)).toContain('seed-reconciled')
  expect(logOf(world)).toContain('handoff-done')
})

test('an uncertain submit exception does not fill a duplicate seed, even after the old seed timeout', async ($, on) => {
  const world = worldOf(on)
  world.failing.add('prompt.submit')
  const clock = mock.clock(on)
  await ready($, world, clock)
  await clock.advance(6_000)
  await clock.advance(121_000)
  expect(world.fills).toEqual([])
  expect(logOf(world)).toContain('seed-delivery-unknown')
  expect(world.statuses.some(s => s?.includes('delivery is unknown'))).toBe(true)
  expect(world.statuses.some(s => s?.includes('press Enter'))).toBe(false)
})
