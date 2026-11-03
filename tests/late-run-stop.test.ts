import { fixturePath } from './fixtures/paths'

// FIXTURE: a Stop published after the brief turn ends must still reach grace safely.
import { expect, mock, test } from 'claude-code/testing'
import { logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TURN, worldOf } from './fixtures/world'

test('the brief turn waits for its late matching Stop instead of aborting a verified brief', async ($, on) => {
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
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  world.files.set(`${STATE}/relay/${OLD}.json`, JSON.stringify({ v: 1, event: 'Stop', session_id: OLD,
    owner: world.env.CONTEXT_HANDOFF_OWNER, generation: world.env.CONTEXT_HANDOFF_ACTIVITY_GENERATION,
    observed_at: 1, transcript_path: fixturePath(`transcripts/${OLD}.jsonl`), background_tasks: [], session_crons: [] }))
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(logOf(world)).not.toContain('cancelled activity-unknown')
  expect(logOf(world)).toContain('handoff-done')
})
