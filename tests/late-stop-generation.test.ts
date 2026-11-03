// FIXTURE: a late native activity change must finish the safety decision.
import { expect, mock, test } from 'claude-code/testing'
import { briefOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TURN, worldOf } from './fixtures/world'

test('activity invalidation while a verified brief waits for Stop aborts visibly without a skill failure', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  world.relayOnStop = false
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(800)
  await $.turn.complete({ ...TURN, turnId: 'background', agentId: 'fixture-agent' } as never)
  await clock.advance(6_000)
  const state = JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`) ?? '{}')
  expect(state.phase).toBe('IDLE')
  expect(state.failedCycles).toBe(0)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(JSON.stringify(world.statuses)).toContain(briefOf(world)!.path)
})

test('activity invalidation before the run queues a brief cancels without charging a skill failure', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  world.relayOnStop = false
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(800)
  await $.turn.complete({ ...TURN, turnId: 'background', agentId: 'fixture-agent' } as never)
  await clock.advance(6_000)
  const state = JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`) ?? '{}')
  expect(state.phase).toBe('IDLE')
  expect(state.failedCycles).toBe(0)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.statuses.join(' ')).toContain('activity changed while waiting for Stop')
})
