import { fixturePath, protocolPath } from './fixtures/paths'

// Engine tests for handoff_now (manual handoff through the machine) and the 65% warning rewrite.
// Run with `claude plugin test <mod dir>`.
import { describe, expect, mock, test } from 'claude-code/testing'

import { HANDOFF_NOW_REFUSAL } from '../hooks/handoff-now'
import { briefOf, logOf, NEW, OLD, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

const TOOL = 'mcp__context-handoff__handoff_now'
const SNAP = fixturePath('snap/s.md')
type Eng = any

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

async function typed($: Eng, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId: TURN.turnId })
}

async function callTool($: Eng, snapshot_path = SNAP) {
  return $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path })
}

describe('handoff_now', () => {
  test('a typed /compact-crafter turn hands off at its end: verified brief, grace, clear, seed; no automatic run, no compaction', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    world.files.set(SNAP, SNAPSHOT_TEXT())
    world.files.set(protocolPath(`claude-project-${OLD}`), 'sample-project\n')
    world.files.set(protocolPath(`claude-project-verified-${OLD}`), 'sample-project\n')
    const clock = mock.clock(on)
    await startSession($, world)
    expect(world.tools).toEqual(['handoff_now'])
    await typed($, '/compact-crafter  \n')
    const answer = await callTool($)
    expect(String(answer.result)).toContain('handing off at the end of this turn')
    expect(world.extractorRuns).toHaveLength(1)
    // The gating prompt, normalised, and any /compact-crafter prompt are excluded from "Last user request".
    expect(world.extractorRuns[0]?.slice(-6)).toEqual(['--exclude-prompt', '/compact-crafter', '--exclude-prefix', '/context-handoff:compact-crafter', '--exclude-prefix', '/compact-crafter'])
    const brief = briefOf(world)
    expect(brief?.text).toContain('mode: continue')
    expect(brief?.text).toContain('## Facts from the transcript')

    await $.turn.complete(TURN)
    await clock.settle()
    await clock.advance(5_000)
    await clock.advance(1_000)
    expect(world.commands).toEqual(['clear'])
    await $.session.end({ reason: 'clear', sessionId: OLD })
    await $.classic.SessionStart({ source: 'clear', session_id: world.sessionId })
    await clock.advance(10)
    expect(world.files.get(protocolPath(`claude-project-${NEW}`))).toBe('sample-project\n')
    expect(world.submits).toHaveLength(1)
    expect(world.compactions).toEqual([])
    expect(logOf(world)).toContain(' handoff-done ')
  })

  test('an invalid snapshot is answered "snapshot invalid: <reason>" and nothing is queued', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    world.files.set(SNAP, SNAPSHOT_TEXT().replace('Status: partial\n', ''))
    const clock = mock.clock(on)
    await startSession($, world)
    await typed($, '/compact-crafter')
    const answer = await callTool($)
    expect(String(answer.result)).toBe('snapshot invalid: section 8 lacks exactly one valid Status line')
    await $.turn.complete(TURN)
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
  })

  test('a turn the user did not start with a handoff request is refused', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    world.files.set(SNAP, SNAPSHOT_TEXT())
    const clock = mock.clock(on)
    await startSession($, world)
    await typed($, 'fix the tests')
    const answer = await callTool($)
    expect(answer.result).toBe(HANDOFF_NOW_REFUSAL)
    await $.turn.complete(TURN)
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
    expect(world.extractorRuns).toEqual([])
  })

  test('a draft in the prompt box at the turn end stops it with a notice', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    world.files.set(SNAP, SNAPSHOT_TEXT())
    const clock = mock.clock(on)
    await startSession($, world)
    await typed($, '/compact-crafter')
    await callTool($)
    world.draft = 'half typed'
    await $.turn.complete(TURN)
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
    expect(world.statuses.some(s => s?.includes('handoff not run'))).toBe(true)
  })

  test('a typed prompt during the manual grace cancels it; no clear', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    world.files.set(SNAP, SNAPSHOT_TEXT())
    const clock = mock.clock(on)
    await startSession($, world)
    await typed($, '/compact-crafter')
    await callTool($)
    await $.turn.complete(TURN)
    await clock.settle()
    await $.prompt.submit({ text: 'wait', wait: false, origin: { kind: 'composer' } })
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
  })
})

describe('item 12: the 65% warning', () => {
  test('a CONTEXT COMPACT line from a settings hook is rewritten while the mod is active', async ($, on) => {
    worldOf(on)
    mock.clock(on)
    on('classic.PostToolUse', () => ({ additionalContext: ['CONTEXT COMPACT (66%): ... then run /compact ...'] }))
    await $.session.start(SESSION_START)
    const result = await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'x' })
    expect(result.additionalContext?.[0]).toMatch(/^CONTEXT HANDOFF \(66%\)/)
  })

  test('with the kill switch on it is left alone', async ($, on) => {
    const world = worldOf(on)
    mock.clock(on)
    on('classic.PostToolUse', () => ({ additionalContext: ['CONTEXT COMPACT (66%): run /compact'] }))
    await $.session.start(SESSION_START)
    world.files.set(fixturePath('state/DISABLED'), '')
    const result = await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'x' })
    expect(result.additionalContext?.[0]).toBe('CONTEXT COMPACT (66%): run /compact')
  })
})
