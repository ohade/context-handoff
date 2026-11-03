import { fixturePath } from './fixtures/paths'

// W2g round 1 engine tests, run with `claude plugin test <mod dir>`. The transcript record is
// dispatched only when it would change the state, the classic.SessionStart wiring is pinned, and a
// SessionStart whose id is not the process's never records a path. Written red-first.
import { describe, expect, mock, test } from 'claude-code/testing'

import { NEW, OLD, SESSION_START, STATE, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const NEW_PATH = fixturePath(`home/.claude/projects/p/${NEW}.jsonl`)
const TOOL_RESULT = { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'x' }
const fileOf = (sessionId: string): string => `${STATE}/sessions/${sessionId}.json`

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

function stateOf(world: World, sessionId: string): { sessionId: string; transcriptPath: string | null } {
  const text = world.files.get(fileOf(sessionId))
  expect(text).toBeDefined()
  return JSON.parse(text as string)
}

describe('W2g r1: no noop dispatch, SessionStart wiring', () => {
  test('ten main tool results from another session write no state', async ($: Eng, on: Eng) => {
    const world = worldOf(on, { relayOnStart: false })
    const clock = mock.clock(on)
    on('classic.PostToolUse', () => ({}))
    world.tokens = 10_000
    world.percent = 1
    await $.session.start(SESSION_START)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
    await settle(clock)
    expect(stateOf(world, OLD).transcriptPath).toBeNull()
    // The observable: delete the state file; any persist recreates it.
    world.files.delete(fileOf(OLD))
    for (let i = 0; i < 10; i += 1) {
      await $.classic.PostToolUse({ ...TOOL_RESULT, tool_use_id: `m${i}`, session_id: NEW, transcript_path: NEW_PATH })
    }
    await settle(clock)
    expect(world.files.has(fileOf(OLD))).toBe(false)
    expect(world.files.has(fileOf(NEW))).toBe(false)
  })

  test('a Stop sets OLD\'s path; SessionStart(clear) with the NEW id and path leaves the state at NEW with NEW\'s path', async ($: Eng, on: Eng) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await $.session.start(SESSION_START)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
    await settle(clock)
    expect(stateOf(world, OLD).transcriptPath).toBe(TRANSCRIPT)
    world.sessionId = NEW
    await $.classic.SessionStart({ source: 'clear', session_id: NEW, transcript_path: NEW_PATH })
    await settle(clock)
    const state = stateOf(world, NEW)
    expect([state.sessionId, state.transcriptPath]).toEqual([NEW, NEW_PATH])
  })

  test('a SessionStart carrying an id that is not the process\'s records no path', async ($: Eng, on: Eng) => {
    const world = worldOf(on, { relayOnStart: false })
    const clock = mock.clock(on)
    await $.session.start(SESSION_START)
    await settle(clock)
    world.sessionId = NEW
    await $.classic.SessionStart({ source: 'clear', session_id: OLD, transcript_path: NEW_PATH })
    await settle(clock)
    expect(stateOf(world, OLD).transcriptPath).toBeNull()
  })
})
