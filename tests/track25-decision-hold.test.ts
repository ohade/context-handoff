// TRACK-25 U2 engine tests, run with `claude plugin test <mod dir>`: a 👉 decision with no Track
// waiting row holds the automatic run, re-asks with the next tool result, and never drops the turn
// end on a Track failure or starts a run from a stale callback. Written red-first.
import { describe, expect, mock, test } from 'claude-code/testing'

import { NOTES_ONLY } from '../hooks/decision-hold'
import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { nudgeText } from '../hooks/nudge'
import { logOf, NEW, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL_RESULT = { tool: 'Bash', command: 'pwd', tool_use_id: 'x' }
const TRACK_TOOLS = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']
const DECISION = 'Two options.\n👉 Reply go or no.'
const HELD = 'clean-wait decision-unregistered (turn end 1 since the nudge)'
const waiting = { id: 'plan:9', status: 'waiting', subject: 'Pick go or no', note: 'Owner: User; reply go or no' }
const checkpoint = (rows: unknown[]) =>
  ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: rows.length }, open_steps: rows })

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

async function stop($: Eng, world: World): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

/** As tests/w2e.test.ts: a session, a typed turn t1, and one main tool result at 412k tokens (the nudge). */
async function nudgedTurn($: Eng, on: Eng, world: World, clock: Clock): Promise<void> {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  world.tokens = 412_345
  world.percent = 41
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.session.start(SESSION_START)
  await stop($, world)
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
  await $.tool.call(TOOL_RESULT)
  await settle(clock)
}

/** Track answers `answer()` for the checkpoint tool; every call is recorded. */
function track(on: Eng, answer: () => unknown): string[] {
  const calls: string[] = []
  on('tool.call', { tool: /^mcp__track__/ }, async (_: unknown, e: { tool: string }) => {
    calls.push(e.tool)
    return answer()
  })
  return calls
}

const stateOf = (world: World) => JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`) ?? '{}')
const phase = (world: World) => stateOf(world).phase

const HANDOFF_NOW = 'mcp__context-handoff__handoff_now'
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }
/** A declared item with a real Track id, its exact waiting row, and the unregistered 👉 decision (null track_id). */
const realItem = { track_id: 'plan:7', subject: 'Review the change', note: 'Owner: User; approve the change', unblock: 'Approve the change' }
const realRow = { id: realItem.track_id, subject: realItem.subject, note: realItem.note, status: 'waiting' }
const looseItem = { track_id: null, subject: 'Pick go or no', note: 'Owner: User; reply go or no', unblock: 'Reply go or no' }
const notesSnapshot = () => SNAPSHOT_TEXT().replace('## 3. Pending, owned by the user\n- none',
  `## 3. Pending, owned by the user\n${[looseItem, realItem].map(item => `- Pending: ${JSON.stringify(item)}`).join('\n')}`)

/** Track answers both tools from the current rows; every call is recorded. */
function trackRows(on: Eng, rows: () => unknown[]): string[] {
  const calls: string[] = []
  on('tool.call', { tool: /^mcp__track__/ }, (_: unknown, e: { tool: string }) => {
    calls.push(e.tool)
    const receipt = checkpoint(rows())
    return { result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? receipt : { ...receipt, destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }
  })
  return calls
}

/** Three held 👉 turn ends with no waiting row, then the fourth starts the run at the decision limit. */
async function heldToLimit($: Eng, on: Eng, world: World, clock: Clock): Promise<void> {
  await nudgedTurn($, on, world, clock)
  for (const turnId of ['t1', 't2', 't3', 't4']) {
    if (turnId !== 't1') await $.turn.start({ text: 'continue', turnId })
    await stop($, world)
    await $.turn.complete({ ...TURN, turnId, answer: DECISION })
    await settle(clock)
  }
}

/** The run turn of `cycle`, reading the snapshot with the null-track_id and the real-id item. */
async function runTurn($: Eng, world: World, cycle: string, turnId: string): Promise<void> {
  world.files.set(RUN_SNAPSHOT, notesSnapshot())
  await $.prompt.submit({ text: RUN_PROMPT(cycle), wait: false, origin: OWN })
  await $.turn.start({ text: RUN_TURN_TEXT(cycle), turnId })
}

describe('the hold', () => {
  test('a 👉 answer with no waiting row: no run, one checkpoint call, the next tool result re-asks, a pinned reason', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    let rows: unknown[] = []
    const calls = track(on, () => ({ result: JSON.stringify(checkpoint(rows)) }))
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(calls).toEqual(['mcp__track__checkpoint'])
    expect(logOf(world)).toContain('decision-check waiting=0')
    expect(logOf(world)).toContain(HELD)
    expect(world.statuses.join(' ')).toContain('waiting step in Track')
    const next = await $.tool.call(TOOL_RESULT)
    expect(next.context).toEqual([nudgeText(412_345, 41)])

    rows = [waiting]
    await $.turn.start({ text: 'continue', turnId: 't2' })
    await stop($, world)
    await $.turn.complete({ ...TURN, turnId: 't2', answer: DECISION })
    await settle(clock)
    expect(logOf(world)).toContain('decision-check waiting=1')
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('the later dispatch: an unknown Stop then a late one still checks Track and holds', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    const calls = track(on, () => ({ result: JSON.stringify(checkpoint([])) }))
    await nudgedTurn($, on, world, clock)
    world.relayOnStop = false
    await $.turn.complete({ ...TURN, answer: DECISION })
    await clock.advance(100)
    world.relayOnStop = true
    await stop($, world)
    await clock.advance(6_000)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(calls).toEqual(['mcp__track__checkpoint'])
    expect(logOf(world)).toContain('clean-wait decision-unregistered')
    // The unknown first dispatch did not spend the window's one re-arm.
    const next = await $.tool.call(TOOL_RESULT)
    expect(next.context).toEqual([nudgeText(412_345, 41)])
  })

  test('Track absent: the 👉 answer takes the ordinary run path', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).not.toContain('decision-unregistered')
  })
})

describe('Track failures and stale callbacks', () => {
  test('a timed-out checkpoint holds as unknown; the turn end is not dropped', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    track(on, () => new Promise(() => {}))
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await clock.advance(10_000)
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain('decision-check failed: timed out')
    expect(logOf(world)).toContain(HELD)
    expect(phase(world)).toBe('IDLE')
  })

  test('a rejected checkpoint holds as unknown; the turn end is not dropped', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    track(on, () => { throw new Error('track down') })
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await settle(clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain('decision-check failed:')
    expect(logOf(world)).toContain(HELD)
  })

  test('a stalled checkpoint followed by newer activity starts no run and dispatches no stale turn end', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    let release: (value: unknown) => void = () => {}
    const calls = track(on, () => new Promise(resolve => { release = resolve }))
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await clock.advance(100)
    await $.turn.complete({ ...TURN, turnId: 'background', agentId: 'fixture-agent' } as never)
    release({ result: JSON.stringify(checkpoint([waiting])) })
    await settle(clock)
    await clock.advance(6_000)
    expect(calls).toEqual(['mcp__track__checkpoint'])
    expect(world.commands).toEqual([])
    expect(logOf(world)).not.toContain('decision-unregistered')
    expect(logOf(world)).not.toContain(' briefing ')
    expect(phase(world)).toBe('IDLE')
  })
})

describe('a draft typed during the Track read', () => {
  test('the guards are read again after a stalled checkpoint: the draft starts no run', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    let release: (value: unknown) => void = () => {}
    const calls = track(on, () => new Promise(resolve => { release = resolve }))
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await clock.advance(100)
    world.draft = 'half typed'
    // A waiting row: without the re-read this turn end would start the run.
    release({ result: JSON.stringify(checkpoint([waiting])) })
    await settle(clock)
    expect(calls).toEqual(['mcp__track__checkpoint'])
    expect(logOf(world)).toContain('decision-check waiting=1')
    expect(logOf(world)).toContain('clean-wait draft-in-prompt-box (turn end 1 since the nudge)')
    expect(world.commands).toEqual([])
    expect(phase(world)).toBe('IDLE')
  })
})

describe('the decision limit: notes only for the unregistered item', () => {
  test('the fourth held end runs; the null-track_id item passes, a real id still needs its exact row; the seed says notes only', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    let rows: unknown[] = []
    trackRows(on, () => rows)
    await heldToLimit($, on, world, clock)
    expect(logOf(world)).toContain('decision-limit 3 turn ends since the nudge (limit 3); decision-unregistered: running anyway')
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])

    rows = [{ ...realRow, note: 'Outdated blocker' }]
    await runTurn($, world, CYCLE, 't5')
    const refused = await $.tool.call({ tool: HANDOFF_NOW, tool_use_id: 'tu-run', snapshot_path: RUN_SNAPSHOT })
    expect(String(refused.result)).toContain('snapshot invalid: pending: plan:7')
    expect(String(refused.result)).not.toContain(looseItem.subject)

    rows = [realRow]
    const accepted = await $.tool.call({ tool: HANDOFF_NOW, tool_use_id: 'tu-run-2', snapshot_path: RUN_SNAPSHOT })
    expect(String(accepted.result)).toStartWith(HANDOFF_NOW_QUEUED)
    await $.turn.complete({ ...TURN, turnId: 't5' })
    await clock.advance(7_000)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
    expect(world.sessionId).toBe(NEW)
    expect(JSON.stringify(world.notes)).toContain(NOTES_ONLY)
  })

  test('the override ends with its cycle: a later cycle refuses the same null-track_id item', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    let rows: unknown[] = []
    trackRows(on, () => rows)
    await heldToLimit($, on, world, clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    // The decision-limit run fails before handoff_now: that cycle ends without a clear.
    await runTurn($, world, CYCLE, 't5')
    await $.turn.complete({ ...TURN, turnId: 't5', reason: 'error' })
    await settle(clock)
    expect(phase(world)).toBe('IDLE')

    // A typed prompt and 108k tokens of growth: the next clean turn end without a 👉 starts a later cycle.
    world.tokens = 520_000
    world.percent = 52
    await $.prompt.submit({ text: 'next step', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'next step', turnId: 't6' })
    await stop($, world)
    await $.turn.complete({ ...TURN, turnId: 't6' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'context-handoff:compact-crafter'])
    const later = stateOf(world).cycleId
    expect(later).not.toBe(CYCLE)

    rows = [realRow]
    await runTurn($, world, later, 't7')
    const refused = await $.tool.call({ tool: HANDOFF_NOW, tool_use_id: 'tu-run-3', snapshot_path: RUN_SNAPSHOT })
    // TRACK-25 U3 quotes a null-id subject as JSON on the automatic door (merge reconciliation, 2026-10-22).
    expect(String(refused.result)).toContain(`snapshot invalid: pending: ${JSON.stringify(looseItem.subject)}`)
  })
})

// Decision and background-work coverage: the TRACK-33 shared gate, and the
// isKnown-path generation recheck after the guard re-reads.
const hasAsk = (r: { context?: unknown[] }) => JSON.stringify(r.context ?? []).includes('waiting step in Track')
const READ_OK = () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } })

describe('W1 polish: the re-arm rides one tool result, never the run', () => {
  test('three held ends, each followed by a tool call: only the first next tool result re-asks', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    track(on, () => ({ result: JSON.stringify(checkpoint([])) }))
    await nudgedTurn($, on, world, clock)
    const seen: boolean[] = []
    for (const turnId of ['t1', 't2', 't3']) {
      if (turnId !== 't1') await $.turn.start({ text: 'continue', turnId })
      await stop($, world)
      await $.turn.complete({ ...TURN, turnId, answer: DECISION })
      await settle(clock)
      seen.push(hasAsk(await $.tool.call({ ...TOOL_RESULT, tool_use_id: `x-${turnId}` })))
    }
    expect(seen).toEqual([true, false, false])
    expect(world.commands).toEqual([])
  })

  test('a re-arm queued by a held end with no tool call after it never rides the run turn\'s first tool result', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Read' }, READ_OK)
    let rows: unknown[] = []
    track(on, () => ({ result: JSON.stringify(checkpoint(rows)) }))
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await settle(clock)
    expect(logOf(world)).toContain('nudge-rearmed')
    // The next turn makes no tool call; the row is registered; its end starts the run.
    rows = [waiting]
    await $.turn.start({ text: 'continue', turnId: 't2' })
    await stop($, world)
    await $.turn.complete({ ...TURN, turnId: 't2', answer: DECISION })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
    await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't3' })
    const read = await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: RUN_SNAPSHOT })
    expect(read.deny).toBeUndefined()
    expect(hasAsk(read)).toBe(false)
    expect(JSON.stringify(read.context ?? [])).not.toContain('Context is at')
  })
})

describe('W1 polish: the isKnown path rechecks the generation after the guard re-reads', () => {
  test('newer activity during the re-read of the prompt box: no run starts and the stale turn end is not dispatched', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    let release: (value: unknown) => void = () => {}
    const calls = track(on, () => new Promise(resolve => { release = resolve }))
    await nudgedTurn($, on, world, clock)
    await stop($, world)
    await $.turn.complete({ ...TURN, answer: DECISION })
    await clock.advance(100)
    // The fixture's one-shot hold: the next prompt.read (the guard re-read after the Track read) waits for the test.
    let releaseRead: () => void = () => {}
    world.promptReadHold = new Promise<void>(resolve => { releaseRead = resolve })
    // A waiting row: without the recheck this turn end would start the run.
    release({ result: JSON.stringify(checkpoint([waiting])) })
    await settle(clock)
    expect(world.promptReadHeld).toBe(1)
    await $.turn.complete({ ...TURN, turnId: 'background', agentId: 'fixture-agent' } as never)
    releaseRead()
    await settle(clock)
    await clock.advance(6_000)
    expect(calls).toEqual(['mcp__track__checkpoint'])
    expect(world.commands).toEqual([])
    expect(logOf(world)).not.toContain(' briefing ')
    expect(phase(world)).toBe('IDLE')
    expect(logOf(world)).toContain('decision-check stale: activity changed during the guard re-reads')
  })
})
