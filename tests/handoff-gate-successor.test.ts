import { fixturePath } from './fixtures/paths'

// Handoff-gate successor pins (brief-mod-successor, rulings Q57): G1 origin discrimination (M12) and G2 plan
// preservation through Track's landed after:'last' (M13, M13b, M13c). Run with `claude plugin test <mod dir>`.
// FIXTURE: Track is a stand-in beneath the mod that models the compatible Track for track_steps:
// after:'last' anchors on the last stored plan row whatever its status or cleared flag, no plan row takes the
// creation path, any other unknown id is refused; omitting after replaces the plan rows and keeps the rest.
// lookup_rows answers only rows not cleared. `legacy` models a Track without append support, which refuses 'last'.
import { describe, expect, mock, test } from 'claude-code/testing'

import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL = 'mcp__context-handoff__handoff_now'
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }
const ENGINE = 'engine'
const RUN_DENY = 'context-handoff automatic run: '
const SNAP = fixturePath('snap/s.md')
const STEPS = 'mcp__track__track_steps'
const MARK = 'mcp__track__mark_step'
const LOOKUP = 'mcp__track__lookup_rows'
const TRACK_TOOLS = ['mcp__track__checkpoint', 'mcp__track__restore_tracker', LOOKUP, STEPS, MARK]
const AUTO_TITLE = `context-handoff: prepare snapshot ${CYCLE}`

type Row = { id: string; source: 'plan' | 'task' | 'todo'; status: string; subject: string; cleared?: true }
type Call = { tool: string; args: Record<string, unknown>; origin: { plugin: string }; session: string }
type Hold = { arrived: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void }
type Track = { rows: Row[]; calls: Call[]; order: string[]; legacy: boolean; holdOwnPause: Hold | null }

const answerOf = (verb: string, added: Row[]) => `${verb}: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.`

/** The stand-in parks the mod's own pause on `arrived` until the test calls `release`. */
function holdOf(): Hold {
  let arrive = () => {}
  let release = () => {}
  const arrived = new Promise<void>(resolve => { arrive = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { arrived, arrive: () => arrive(), released, release: () => release() }
}

/** The landed-Track stand-in, seated beneath the mod; every other tool runs and is recorded in `order`. */
function trackOf(on: any, world: World, rows: Row[]): Track {
  world.toolNames = [...TRACK_TOOLS]
  const t: Track = { rows: rows.map(row => ({ ...row })), calls: [], order: [], legacy: false, holdOwnPause: null }
  const checkpoint = () => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: t.rows.length } })
  on('tool.call', async (_: unknown, e: any, next: any) => {
    const { tool, tool_use_id: _id, ...args } = e
    t.order.push(tool)
    if (!String(tool).startsWith('mcp__track__')) return { result: 'ran' }
    t.calls.push({ tool, args, origin: next.origin, session: world.sessionId })
    if (tool === 'mcp__track__checkpoint') return { result: JSON.stringify(checkpoint()) }
    if (tool === 'mcp__track__restore_tracker') return { result: JSON.stringify({ ...checkpoint(), destination_session: world.sessionId, applied_checksum: 'a'.repeat(64) }) }
    if (tool === LOOKUP) {
      const visible = t.rows.filter(row => row.cleared !== true)
      return { result: JSON.stringify({ ok: true, rows: visible.map((row, i) => ({ label: `S${i + 1}`, id: row.id, kind: 'step', status: row.status, subject: row.subject })) }) }
    }
    if (tool === STEPS) {
      const plans = t.rows.filter(row => row.source === 'plan')
      const top = Math.max(0, ...t.rows.map(row => Number(/^plan:(\d+)$/.exec(row.id)?.[1] ?? 0)))
      const titles = args.steps as string[]
      if (args.after === undefined) {
        const open = plans.filter(row => row.cleared !== true && row.status !== 'completed')
        if (open.length > 0) return { result: `Not replaced: open plan steps ${open.map(row => row.id).join(', ')}; pass replace: true or use after.` }
        const added = titles.map((subject, k): Row => ({ id: `plan:${k + 1}`, source: 'plan', status: 'pending', subject }))
        t.rows = [...t.rows.filter(row => row.source !== 'plan'), ...added]
        return { result: answerOf(`Tracking ${added.length} steps`, added) }
      }
      const isLast = args.after === 'last' && !t.legacy
      const anchor = isLast ? plans[plans.length - 1]?.id : String(args.after)
      if (isLast && anchor === undefined) {
        const added = titles.map((subject, k): Row => ({ id: `plan:${k + 1}`, source: 'plan', status: 'pending', subject }))
        t.rows = [...t.rows, ...added]
        return { result: answerOf(`Tracking ${added.length} steps`, added) }
      }
      const i = t.rows.findIndex(row => row.id === anchor)
      if (i < 0) return { result: `No step ${String(args.after)}. Known steps: ${t.rows.map(row => row.id).join(', ') || 'none'}.` }
      const added = titles.map((subject, k): Row => ({ id: `plan:${top + k + 1}`, source: 'plan', status: 'pending', subject }))
      t.rows.splice(i + 1, 0, ...added)
      return { result: answerOf(`Inserted after ${anchor}`, added) }
    }
    if (tool === MARK) {
      const hold = t.holdOwnPause
      if (hold !== null && args.status === 'paused' && next.origin?.plugin !== ENGINE) {
        t.holdOwnPause = null
        hold.arrive()
        await hold.released
      }
      const row = t.rows.find(r => r.id === args.id)
      if (row === undefined) return { result: `No change. Known steps: ${t.rows.map(r => `${r.id} (${r.status})`).join(', ')}.` }
      row.status = String(args.status)
      return { result: `Step ${row.id} "${row.subject}" marked ${row.status}.` }
    }
    return { result: '' }
  })
  return t
}

const creations = (t: Track) => t.calls.filter(c => c.tool === STEPS)
const marks = (t: Track) => t.calls.filter(c => c.tool === MARK)

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

/** A typed turn ends over the threshold, the skill run starts, and its bound turn t2 is current. */
async function inRunTurn($: Eng, world: World, clock: Clock): Promise<void> {
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await startSession($, world)
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: TURN.turnId })
  await $.turn.complete(TURN)
  await settle(clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
  await $.turn.start({ text: RUN_TURN_TEXT(CYCLE), turnId: 't2' })
}

/** A typed /compact-crafter turn (the manual route), below the threshold. */
async function inManualTurn($: Eng, world: World): Promise<void> {
  world.files.set(SNAP, SNAPSHOT_TEXT())
  await startSession($, world)
  await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
}

const writeSnapshot = ($: Eng, id = 'w1') => $.tool.call({ tool: 'Write', tool_use_id: id, file_path: RUN_SNAPSHOT, content: SNAPSHOT_TEXT() })
const handoffNow = ($: Eng, snapshot_path: string, id = 'tu1') => $.tool.call({ tool: TOOL, tool_use_id: id, snapshot_path })

const plan = (n: number, status: string, extra: Partial<Row> = {}): Row => ({ id: `plan:${n}`, source: 'plan', status, subject: `step ${n}`, ...extra })
const task: Row = { id: 'task:3', source: 'task', status: 'in_progress', subject: 'native task' }

describe('[M12] origin discrimination (GREEN control; mutant M11-origin.diff must fail it)', () => {
  test('a model-origin mark_step with the identical arguments, raised while the mod\'s own pause is pending, is refused and never reaches Track', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world, [plan(1, 'completed')])
    await inRunTurn($, world, clock)
    expect((await writeSnapshot($)).deny, 'the step is registered and the Write runs').toBeUndefined()
    expect(creations(t), 'the step was registered').toHaveLength(1)
    // The tool cap ends the run inside the guard; the mod pauses its step from that frame, and the stand-in
    // holds the pause, so the mod's own recorded call is pending while the model call arrives.
    const hold = holdOf()
    t.holdOwnPause = hold
    let capped: Promise<{ deny?: string }> | null = null
    for (let i = 0; i < 40 && capped === null; i++) {
      const call = $.tool.call({ tool: 'Bash', tool_use_id: `b${i}`, command: 'true' }) as Promise<{ deny?: string }>
      const first = await Promise.race([call.then(() => 'answered'), hold.arrived.then(() => 'held')])
      if (first === 'held') capped = call
    }
    expect(capped, 'the cap was reached and the mod raised its own pause').not.toBeNull()
    const pending = marks(t)[0]
    expect(pending?.origin.plugin, 'the pending pause is the mod\'s own').toBe('context-handoff')
    expect(logOf(world), 'premise: the own pause was raised from the guard frame and is still pending, not admitted').not.toMatch(/own-track-admitted/)
    const replay = await $.tool.call({ tool: MARK, tool_use_id: 'm12', ...(pending?.args ?? {}) })
    hold.release()
    await capped
    await settle(clock)
    expect(String(replay.deny), 'a model-origin call with identical arguments is refused').toStartWith(RUN_DENY)
    expect(marks(t).filter(c => c.origin.plugin === ENGINE), 'no model-origin mark reaches Track').toEqual([])
    expect(t.rows.find(row => row.id === 'plan:2')?.status, 'the step is paused once, by the mod').toBe('paused')
  })
})

describe('[M13] cleared history is preserved', () => {
  test('a ledger whose only plan row is completed and cleared keeps that row; the step goes after it via after:"last"', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world, [plan(1, 'completed', { cleared: true })])
    await inRunTurn($, world, clock)
    expect((await writeSnapshot($)).deny).toBeUndefined()
    expect(creations(t).map(c => c.args), 'registration always uses after:"last"').toEqual([{ steps: [AUTO_TITLE], after: 'last' }])
    expect(t.calls.filter(c => c.tool === LOOKUP), 'the pane is not looked up').toEqual([])
    expect(t.rows).toEqual([plan(1, 'completed', { cleared: true }), { id: 'plan:2', source: 'plan', status: 'pending', subject: AUTO_TITLE }])
    await handoffNow($, RUN_SNAPSHOT)
    expect(marks(t).map(c => [c.args.id, c.args.status])).toEqual([['plan:2', 'completed']])
    expect(t.rows[0], 'the cleared row is untouched').toEqual(plan(1, 'completed', { cleared: true }))
  })
})

describe('[M13b] truly empty plan', () => {
  test('with only a task row, after:"last" takes the creation path; the task row is kept and the step completes', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    mock.clock(on)
    const t = trackOf(on, world, [task])
    await inManualTurn($, world)
    const answer = await handoffNow($, SNAP)
    expect(String(answer.result)).toContain(HANDOFF_NOW_QUEUED)
    expect(creations(t).map(c => c.args.after), 'registration always uses after:"last"').toEqual(['last'])
    expect(t.rows.map(row => [row.id, row.source, row.status])).toEqual([['task:3', 'task', 'in_progress'], ['plan:1', 'plan', 'completed']])
    expect(t.rows[0]).toEqual(task)
  })
})

describe('[M13c] an older Track that refuses "last" fails closed', () => {
  test('automatic: the Write is refused with one line, one attempt, and the Write never runs', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world, [plan(1, 'completed')])
    t.legacy = true
    await inRunTurn($, world, clock)
    const first = await writeSnapshot($, 'w1')
    expect(String(first.deny)).toStartWith(RUN_DENY)
    expect(String(first.deny)).not.toContain('\n')
    expect(t.order, 'the Write never ran').not.toContain('Write')
    const second = await writeSnapshot($, 'w2')
    expect(String(second.deny)).toStartWith(RUN_DENY)
    expect(creations(t).map(c => c.args.after), 'one attempt, with after:"last"').toEqual(['last'])
    expect(t.rows).toEqual([plan(1, 'completed')])
  })

  test('manual: handoff_now answers not queued, no retry, nothing queued', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    const t = trackOf(on, world, [plan(1, 'completed')])
    t.legacy = true
    await inManualTurn($, world)
    const answer = await handoffNow($, SNAP)
    expect(String(answer.result)).toStartWith('handoff not queued')
    expect(creations(t).map(c => c.args.after), 'one attempt, with after:"last"').toEqual(['last'])
    expect(marks(t)).toEqual([])
    await $.turn.complete(TURN)
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
  })
})
