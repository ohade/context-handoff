// TRACK-33 engine tests, run with `claude plugin test <mod dir>`: past the ceiling, every turn end
// held by background work pins why and queues one reminder for the next main tool result; the run
// still starts only at a turn end with nothing running, and a queued TRACK-25 re-arm is never
// replaced or doubled. Written red-first, on the tests/w2e.test.ts pattern.
import { describe, expect, mock, test } from 'claude-code/testing'

import { nudgeText } from '../hooks/nudge'
import { logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL_RESULT = { tool: 'Bash', command: 'pwd', tool_use_id: 'x' }
const SUBAGENT = { id: 'a1', type: 'subagent', status: 'running', description: 'x' }
const REMINDER = 'Context handoff is waiting for background work to finish. Start no new background work or subagents; let the running ones finish, then end the turn.'
const NOTICE = 'context-handoff: 1 background task(s) hold the handoff past the ceiling; it runs at the first turn end with none running. Start no new background work.'
const TRACK_TOOLS = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']
const DECISION = 'Two options.\n👉 Reply go or no.'
const checkpoint = (rows: unknown[]) =>
  ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: rows.length }, open_steps: rows })

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

async function stop($: Eng, world: World, background_tasks: unknown[] = []): Promise<void> {
  await $.classic.Stop({ stop_hook_active: false, background_tasks, session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
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

/** Turn `turnId` ends with `background` running (none: a clean end). */
async function endTurn($: Eng, world: World, clock: Clock, turnId: string, background: unknown[], answer = TURN.answer): Promise<void> {
  if (turnId !== TURN.turnId) await $.turn.start({ text: 'continue', turnId })
  await stop($, world, background)
  await $.turn.complete({ ...TURN, turnId, answer })
  await settle(clock)
}

const lines = (world: World, event: string) => logOf(world).split('\n').filter(l => l.includes(` ${event} `))

describe('background work holds the handoff past the ceiling', () => {
  test('each held turn end logs, pins the notice and queues the reminder; the first end with nothing running starts the run', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    world.tokens = 600_000

    await endTurn($, world, clock, 't1', [SUBAGENT])
    expect(lines(world, 'ceiling-waiting-bg')).toHaveLength(1)
    expect(world.statuses.filter(s => s === NOTICE)).toHaveLength(1)
    expect(world.commands).toEqual([])
    const first = await $.tool.call(TOOL_RESULT)
    expect(first.context).toEqual([REMINDER])
    const again = await $.tool.call(TOOL_RESULT)
    expect(again.context ?? []).toEqual([])

    await endTurn($, world, clock, 't2', [SUBAGENT])
    expect(lines(world, 'ceiling-waiting-bg')).toHaveLength(2)
    expect(world.statuses.filter(s => s === NOTICE)).toHaveLength(2)
    expect(world.commands).toEqual([])
    const second = await $.tool.call(TOOL_RESULT)
    expect(second.context).toEqual([REMINDER])

    await endTurn($, world, clock, 't3', [])
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a TRACK-25 re-arm queued in the same window is neither replaced nor doubled by a held end', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    on('tool.call', { tool: /^mcp__track__/ }, () => ({ result: JSON.stringify(checkpoint([])) }))
    await nudgedTurn($, on, world, clock)

    await endTurn($, world, clock, 't1', [], DECISION)
    expect(logOf(world)).toContain('clean-wait decision-unregistered')
    world.tokens = 600_000
    await endTurn($, world, clock, 't2', [SUBAGENT])
    expect(lines(world, 'ceiling-waiting-bg')).toHaveLength(1)
    expect(world.statuses).toContain(NOTICE)
    expect(world.commands).toEqual([])

    const next = await $.tool.call(TOOL_RESULT)
    expect(next.context).toEqual([nudgeText(412_345, 41)])
    const after = await $.tool.call(TOOL_RESULT)
    expect(after.context ?? []).toEqual([])
  })
})

// Background-work handoff and reminder coverage.
describe('TRACK-33 polish', () => {
  test('a reminder delivered in a window does not spend that window\'s decision re-arm', async ($, on) => {
    const world = worldOf(on, { toolNames: TRACK_TOOLS })
    const clock = mock.clock(on)
    on('tool.call', { tool: /^mcp__track__/ }, () => ({ result: JSON.stringify(checkpoint([])) }))
    await nudgedTurn($, on, world, clock)
    // Past the ceiling with a subagent running: the reminder is queued and delivered.
    world.tokens = 505_000
    await endTurn($, world, clock, 't1', [SUBAGENT])
    expect(lines(world, 'ceiling-waiting-bg')).toHaveLength(1)
    const reminded = await $.tool.call(TOOL_RESULT)
    expect(reminded.context).toEqual([REMINDER])
    // Below the ceiling again (a 25k drop, no inferred compaction): a held 👉 end in the same window re-arms.
    world.tokens = 480_000
    await endTurn($, world, clock, 't2', [], DECISION)
    expect(logOf(world)).toContain('clean-wait decision-unregistered')
    expect(world.commands).toEqual([])
    const next = await $.tool.call(TOOL_RESULT)
    expect(next.context).toEqual([nudgeText(480_000, 41)])
  })

  test('a reminder queued by a held end with no tool call after it never rides the run turn\'s first tool result', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    await nudgedTurn($, on, world, clock)
    world.tokens = 600_000
    await endTurn($, world, clock, 't1', [SUBAGENT])
    expect(lines(world, 'ceiling-waiting-bg')).toHaveLength(1)
    // No tool call; the next end has nothing running and starts the run.
    await endTurn($, world, clock, 't2', [])
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), wait: false, origin: { kind: 'plugin', name: 'context-handoff' } })
    await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't3' })
    const read = await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: RUN_SNAPSHOT })
    expect(read.deny).toBeUndefined()
    expect(JSON.stringify(read.context ?? [])).not.toContain(REMINDER)
    expect(JSON.stringify(read.context ?? [])).not.toContain('Context is at')
  })

  test('a non-subagent background task holds the run past the ceiling', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    world.tokens = 600_000
    await endTurn($, world, clock, 't1', [{ id: 'b1', type: 'bash', status: 'running', description: 'x' }])
    await clock.advance(6_000)
    expect(lines(world, 'ceiling-waiting-bg')).toHaveLength(1)
    expect(world.commands).toEqual([])
  })

  test('a Stop without background_tasks holds the run past the ceiling (activity unknown)', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await nudgedTurn($, on, world, clock)
    world.tokens = 600_000
    await $.classic.Stop({ stop_hook_active: false, session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
    await $.turn.complete(TURN)
    await settle(clock)
    await clock.advance(6_000)
    expect(world.commands).toEqual([])
  })
})
