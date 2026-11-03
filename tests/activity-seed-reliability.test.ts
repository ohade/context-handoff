// FIXTURE: native activity and uncertain submit outcomes. No worker is started.
import { expect, mock, test } from 'claude-code/testing'
import { seedText } from '../hooks/brief'
import { briefOf, logOf, NEW, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TURN, worldOf } from './fixtures/world'

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

test('native agent spawn after Stop invalidates the earlier idle observation', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ model: 'fixture', agentId: 'background-fixture' }))
  await ready($, world, clock)
  await $.agent.spawn({ prompt: 'fixture only; the test hook starts no worker' })
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.submits).toEqual([])
  expect(logOf(world)).toContain('activity-unknown')
})

test('seed is never submitted into the old session if identity changes while appending its note', async ($, on) => {
  let world: ReturnType<typeof worldOf>
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event !== 'session.append' ? hook : async ($: any, e: any, next: any) => {
      const answer = await hook($, e, next)
      if (world.sessionId === NEW) world.sessionId = OLD
      return answer
    })) as typeof on
  world = worldOf(wrapped)
  const clock = mock.clock(on)
  await ready($, world, clock)
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(world.submits).toEqual([])
  expect(logOf(world)).toContain('seed-session-changed')
})

test('an observed seed turn reconciles a submit exception without filling a duplicate retry', async ($, on) => {
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event !== 'prompt.submit' ? hook : async ($: any, e: any, next: any) => {
      if (e.origin?.kind === 'plugin' && !e.text.startsWith('/context-handoff:compact-crafter automatic-run ')) {
        started()
        await blocked
      }
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
  release()
  await clock.settle()
  expect(world.fills).toEqual([])
  expect(logOf(world)).toContain('seed-reconciled')
  expect(logOf(world)).toContain('handoff-done')
})

test('a refused seed note is recorded as refused and is never reported as appended', async ($, on) => {
  const world = worldOf(on)
  world.failing.add('session.append')
  const clock = mock.clock(on)
  await ready($, world, clock)
  await clock.advance(6_000)
  expect(world.notes).toEqual([])
  expect(logOf(world)).toContain('seed-note-denied')
  expect(logOf(world)).not.toContain(' seed-note ')
})
