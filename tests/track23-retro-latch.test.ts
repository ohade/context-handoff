import { fixturePath } from './fixtures/paths'

// FIXTURE: TRACK-23, 2026-10-19 (audit fix D5). The register.tsx glue of the /retro latch carry:
// handoff_now refuses when a pending latch cannot be carried, a failed carry holds the seed, and a
// carry is logged. world.ts answers every process.run it does not recognise (the `carry --check`
// probe, the facts extractor and the carry itself) with world.extractor, recording each argv in
// world.extractorRuns.
import { describe, expect, mock, test } from 'claude-code/testing'

import { logOf, NEW, OLD, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, briefOf, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

const TOOL = 'mcp__context-handoff__handoff_now'
const SNAP = fixturePath('snap/retro.md')
const GATE = fixturePath('home/.claude/skills/retro/scripts/retro-gate.sh')
type Eng = any

/** A session whose /retro waits for Phase 5 approval, in a typed /compact-crafter turn. */
async function latchedTurn($: Eng, world: World): Promise<void> {
  world.files.set(SNAP, SNAPSHOT_TEXT())
  world.files.set(fixturePath(`home/.claude/state/retro/active-${OLD}`), '1\n')
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
  await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
}

/** handoff_now, then the clear and the new session; the carry exits with `carryExit`. */
async function handOff($: Eng, world: World, clock: Eng, carryExit: number): Promise<void> {
  const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: SNAP })
  expect(String(answer.result)).toContain('handing off at the end of this turn')
  world.extractor = { exitCode: carryExit, stdout: '' }
  await $.turn.complete(TURN)
  await clock.settle()
  await clock.advance(5_000)
  await clock.advance(1_000)
  expect(world.commands).toEqual(['clear'])
  await $.session.end({ reason: 'clear', sessionId: OLD })
  await $.classic.SessionStart({ source: 'clear', session_id: world.sessionId })
  await clock.advance(10)
}

describe('TRACK-23 retro latch carry glue', () => {
  test('(a) a latched session whose carry --check exits 2 is not queued', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    mock.clock(on)
    await latchedTurn($, world)
    world.extractor = { exitCode: 2, stdout: '' }
    const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: SNAP })
    expect(String(answer.result)).toContain('handoff not queued: a /retro approval is pending')
    expect(world.extractorRuns[0]).toEqual(['bash', GATE, 'carry', '--check'])
    expect(briefOf(world)).toBeNull()
  })

  test('(b) a carry that exits 1 holds the seed and pins a retro notice', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    await latchedTurn($, world)
    await handOff($, world, clock, 1)
    expect(world.submits).toEqual([])
    expect(world.statuses.some(s => s?.includes('retro latch not carried'))).toBe(true)
    expect(world.extractorRuns).toContainEqual(['env', `RETRO_STATE_DIR=${fixturePath('home/.claude/state/retro')}`, 'bash', GATE, 'carry', OLD, NEW])
  })

  test('(c) a carry that exits 0 is logged and the seed goes on', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    await latchedTurn($, world)
    await handOff($, world, clock, 0)
    expect(logOf(world)).toContain(' retro-latch-carried ')
    expect(world.submits).toHaveLength(1)
  })
})
