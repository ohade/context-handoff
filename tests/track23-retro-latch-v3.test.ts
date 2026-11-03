import { fixturePath } from './fixtures/paths'

// FIXTURE: The register.tsx glue: a
// session latched only through its previous session carries that latch on (E1), a late clear of a
// latched session carries the latch instead of filling the seed (E4), and a refused `carry --check`
// logs its stderr (E7). world.ts answers every process.run it does not recognise (the probe, the facts
// extractor and the carry) with world.extractor, recording each argv in world.extractorRuns.
import { describe, expect, mock, test } from 'claude-code/testing'

import { logOf, NEW, OLD, SESSION_START, SNAPSHOT_TEXT, STATE, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

const TOOL = 'mcp__context-handoff__handoff_now'
const SNAP = fixturePath('snap/retro.md')
const RETRO = fixturePath('home/.claude/state/retro')
const GATE = fixturePath('home/.claude/skills/retro/scripts/retro-gate.sh')
const PREV = '33333333-aaaa-4bbb-8ccc-000000000003'
type Eng = any

/** A typed /compact-crafter turn in OLD; the test seeds the latch files first. */
async function turn($: Eng, world: World): Promise<void> {
  world.files.set(SNAP, SNAPSHOT_TEXT())
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
  await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
}

/** handoff_now and the end of its turn, up to the clear command; process.run then answers `run`. */
async function toClear($: Eng, world: World, clock: Eng, run: World['extractor']): Promise<void> {
  const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: SNAP })
  expect(String(answer.result)).toContain('handing off at the end of this turn')
  world.extractor = run
  await $.turn.complete(TURN)
  await clock.settle()
  await clock.advance(5_000)
  await clock.advance(1_000)
  expect(world.commands).toEqual(['clear'])
}

/** The new session's SessionStart(clear), id NEW. */
async function newSession($: Eng, world: World, clock: Eng): Promise<void> {
  world.sessionId = NEW
  await $.session.end({ reason: 'clear', sessionId: OLD })
  await $.classic.SessionStart({ source: 'clear', session_id: NEW })
  await clock.advance(10)
}

describe('TRACK-23 v3 retro latch carry glue', () => {
  test('(d) a session latched only through its previous session carries that latch to the new id', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    // OLD was handed off from PREV, whose carry failed: OLD has no latch of its own.
    world.files.set(`${STATE}/sessions/${OLD}.json`, JSON.stringify({ version: 1, sessionId: OLD, phase: 'IDLE', cycleSeq: 0, autoChain: 0, enteredAt: 0, previousSessionId: PREV }))
    world.files.set(`${RETRO}/active-${PREV}`, '1\n')
    await turn($, world)
    await toClear($, world, clock, { exitCode: 0, stdout: '' })
    await newSession($, world, clock)
    expect(world.extractorRuns).toContainEqual(['env', `RETRO_STATE_DIR=${RETRO}`, 'bash', GATE, 'carry', PREV, NEW])
    expect(logOf(world)).toContain(`${PREV} -> ${NEW}`)
  })

  test('(e) a refused carry --check logs its stderr', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    mock.clock(on)
    world.files.set(`${RETRO}/active-${OLD}`, '1\n')
    await turn($, world)
    world.extractor = { exitCode: 2, stdout: '', stderr: 'usage: retro-gate.sh begin <session> <tier>' }
    const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: SNAP })
    expect(String(answer.result)).toContain('handoff not queued: a /retro approval is pending')
    expect(logOf(world)).toContain('usage: retro-gate.sh begin <session> <tier>')
  })

  test('(f) a late clear of a latched session carries the latch and does not fill the seed', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000, clearSwitchesTo: null })
    const clock = mock.clock(on)
    world.files.set(`${RETRO}/active-${OLD}`, '1\n')
    await turn($, world)
    await toClear($, world, clock, { exitCode: 1, stdout: '' })
    await clock.advance(6_000)
    expect(logOf(world)).toContain(' new-id-missing ')
    await newSession($, world, clock)
    expect(world.fills).toEqual([])
    expect(world.extractorRuns).toContainEqual(['env', `RETRO_STATE_DIR=${RETRO}`, 'bash', GATE, 'carry', OLD, NEW])
    expect(world.statuses.some(s => s?.includes('retro latch not carried'))).toBe(true)
  })
})
