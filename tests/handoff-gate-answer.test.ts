import { fixturePath } from './fixtures/paths'

// FIXTURE: synthetic Track preparation answers include a status line followed by
// a Saved row JSON receipt. The plugin accepts this public response format.
import { describe, expect, mock, test } from 'claude-code/testing'

import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL = 'mcp__context-handoff__handoff_now'
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }
const SNAP = fixturePath('snap/s.md')
const STEPS = 'mcp__track__track_steps'
const MARK = 'mcp__track__mark_step'
const TRACK_TOOLS = ['mcp__track__checkpoint', 'mcp__track__restore_tracker', 'mcp__track__lookup_rows', STEPS, MARK]

type Row = { id: string; status: string; subject: string; note?: string }
type Call = { tool: string; args: Record<string, unknown> }
type Track = { rows: Row[]; calls: Call[] }

/** A Track stand-in whose mark_step answers exactly as live Track does, Saved row tail included. */
function liveTrackOf(on: any, world: World): Track {
  world.toolNames = [...TRACK_TOOLS]
  const t: Track = { rows: [{ id: 'plan:1', status: 'completed', subject: 'earlier work' }], calls: [] }
  const checkpoint = () => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: t.rows.length } })
  on('tool.call', (_: unknown, e: any) => {
    const { tool, tool_use_id: _id, ...args } = e
    if (!String(tool).startsWith('mcp__track__')) return { result: 'ran' }
    t.calls.push({ tool, args })
    if (tool === 'mcp__track__checkpoint') return { result: JSON.stringify(checkpoint()) }
    if (tool === 'mcp__track__restore_tracker') return { result: JSON.stringify({ ...checkpoint(), destination_session: world.sessionId, applied_checksum: 'a'.repeat(64) }) }
    if (tool === 'mcp__track__lookup_rows') return { result: JSON.stringify({ ok: true, rows: t.rows.map((row, i) => ({ label: `S${i + 1}`, id: row.id, kind: 'step', status: row.status, subject: row.subject })) }) }
    if (tool === STEPS) {
      const top = Math.max(0, ...t.rows.map(row => Number(/^plan:(\d+)$/.exec(row.id)?.[1] ?? 0)))
      const added = (args.steps as string[]).map((subject, k) => ({ id: `plan:${top + k + 1}`, status: 'pending', subject }))
      const anchor = [...t.rows].reverse().find(row => row.id.startsWith('plan:'))?.id
      t.rows.push(...added)
      return { result: `Inserted after ${String(anchor)}: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
    }
    if (tool === MARK) {
      const row = t.rows.find(r => r.id === args.id)
      if (row === undefined) return { result: `No change. Known steps: ${t.rows.map(r => `${r.id} (${r.status})`).join(', ')}.` }
      row.status = String(args.status)
      if (typeof args.note === 'string') row.note = args.note
      const { id, subject, status, note } = row
      return { result: `Step ${id} "${subject}" marked ${status}.\nSaved row: ${JSON.stringify({ id, subject, status, ...(note !== undefined && { note }) })}` }
    }
    return { result: '' }
  })
  return t
}

const marks = (t: Track) => t.calls.filter(c => c.tool === MARK).map(c => [c.args.id, c.args.status])

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

describe('[A1] the manual route accepts live Track\'s completed answer', () => {
  test('handoff_now in a typed /compact-crafter turn queues once Track answers mark_step with its Saved row tail', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    mock.clock(on)
    const t = liveTrackOf(on, world)
    world.files.set(SNAP, SNAPSHOT_TEXT())
    await startSession($, world)
    await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
    const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: SNAP })
    expect(marks(t), 'the step was marked completed').toEqual([['plan:2', 'completed']])
    expect(logOf(world), 'the live answer is accepted').not.toMatch(/preparation-failed/)
    expect(logOf(world), 'the preparation completed').toMatch(/preparation-completed manual \S+ plan:2/)
    expect(String(answer.result), 'the handoff is queued').toContain(HANDOFF_NOW_QUEUED)
  })
})

describe('[A2] the automatic route accepts live Track\'s completed answer', () => {
  test('a queued handoff_now in the run turn completes the step on the live answer', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = liveTrackOf(on, world)
    world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
    await startSession($, world)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
    await $.turn.complete(TURN)
    await settle(clock)
    await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
    await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't2' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: RUN_SNAPSHOT, content: SNAPSHOT_TEXT() })
    const answer = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', snapshot_path: RUN_SNAPSHOT })
    expect(marks(t), 'the step was marked completed').toEqual([['plan:2', 'completed']])
    expect(logOf(world), 'the live answer is accepted').not.toMatch(/preparation-failed/)
    expect(logOf(world), 'the preparation completed').toMatch(/preparation-completed auto \S+ plan:2/)
    expect(String(answer.result), 'the handoff is queued').toContain(HANDOFF_NOW_QUEUED)
  })
})

describe('[A3] a cancelled cycle accepts live Track\'s paused answer', () => {
  test('a prompt typed over the run turn pauses the open step and the live paused answer is accepted', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = liveTrackOf(on, world)
    world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
    await startSession($, world)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
    await $.turn.complete(TURN)
    await settle(clock)
    await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
    await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't2' })
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: RUN_SNAPSHOT, content: SNAPSHOT_TEXT() })
    await $.prompt.submit({ text: 'stop, I need this', wait: true, turnId: 't2', origin: { kind: 'composer' } })
    await settle(clock)
    expect(marks(t), 'the step was marked paused').toEqual([['plan:2', 'paused']])
    expect(logOf(world), 'the live paused answer is accepted').not.toMatch(/preparation-failed/)
    expect(logOf(world), 'the preparation paused').toMatch(/preparation-paused auto \S+ plan:2/)
  })
})
