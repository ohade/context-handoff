import { fixturePath } from './fixtures/paths'

// FIXTURE: TRACK-23 v4, 2026-10-19 (Codex's v3 review, G1d). The register.tsx glue: a carried-<id>
// that is not a regular file counts as absent, as it does in retro-phase5-gate.sh (`-f && ! -L`), so
// a session latched only through its previous session still carries that latch on. world.ts answers
// fs.exists for a folder (any file below it) and rejects fs.stat without `resolve` for every path but
// the transcript; a folder named carried-<id> is therefore there for exists and not a regular file.
import { describe, expect, mock, test } from 'claude-code/testing'

import { logOf, NEW, OLD, SESSION_START, SNAPSHOT_TEXT, STATE, TRANSCRIPT, TURN, worldOf } from './fixtures/world'

const TOOL = 'mcp__context-handoff__handoff_now'
const SNAP = fixturePath('snap/retro.md')
const RETRO = fixturePath('home/.claude/state/retro')
const GATE = fixturePath('home/.claude/skills/retro/scripts/retro-gate.sh')
const PREV = '33333333-aaaa-4bbb-8ccc-000000000003'

describe('TRACK-23 v4 retro latch carry glue', () => {
  test('(g) a carried-<previous> folder does not count as carried: the latch is carried to the new id', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    // OLD was handed off from PREV, whose carry failed; carried-PREV is a folder, not the marker.
    world.files.set(`${STATE}/sessions/${OLD}.json`, JSON.stringify({ version: 1, sessionId: OLD, phase: 'IDLE', cycleSeq: 0, autoChain: 0, enteredAt: 0, previousSessionId: PREV }))
    world.files.set(`${RETRO}/active-${PREV}`, '1\n')
    world.files.set(`${RETRO}/carried-${PREV}/entry`, '')
    world.files.set(SNAP, SNAPSHOT_TEXT())
    await $.session.start(SESSION_START)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
    await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
    const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: SNAP })
    expect(String(answer.result)).toContain('handing off at the end of this turn')
    world.extractor = { exitCode: 0, stdout: '' }
    await $.turn.complete(TURN)
    await clock.settle()
    await clock.advance(5_000)
    await clock.advance(1_000)
    expect(world.commands).toEqual(['clear'])
    world.sessionId = NEW
    await $.session.end({ reason: 'clear', sessionId: OLD })
    await $.classic.SessionStart({ source: 'clear', session_id: NEW })
    await clock.advance(10)
    expect(world.extractorRuns).toContainEqual(['env', `RETRO_STATE_DIR=${RETRO}`, 'bash', GATE, 'carry', PREV, NEW])
    expect(logOf(world)).toContain(`${PREV} -> ${NEW}`)
  })
})
