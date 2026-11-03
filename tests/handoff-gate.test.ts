import { fixturePath } from './fixtures/paths'

// Handoff-gate pins M1-M11 (contract handoff-gate r3 with errata E-H1, E-H2). Run with `claude plugin test <mod dir>`.
// The mod registers its own Track preparation step, so Track's Stop gate sees a step touched in the run turn:
// the automatic route at the first permitted snapshot Write (inside the tool.call guard), the manual route
// inside handoff_now. FIXTURE: Track is a stand-in beneath the mod that records every call with the origin the
// engine stamped; no Track storage is read.
import { describe, expect, mock, test } from 'claude-code/testing'

import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { logOf, OLD, NEW, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL = 'mcp__context-handoff__handoff_now'
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }
const OWN_ORIGIN = { plugin: 'context-handoff' }
const ENGINE_ORIGIN = { plugin: 'engine' }
const RUN_DENY = 'context-handoff automatic run: '
const SNAP = fixturePath('snap/s.md')
const STEPS = 'mcp__track__track_steps'
const MARK = 'mcp__track__mark_step'
const TRACK_TOOLS = ['mcp__track__checkpoint', 'mcp__track__restore_tracker', 'mcp__track__lookup_rows', STEPS, MARK]
const AUTO_TITLE = `context-handoff: prepare snapshot ${CYCLE}`

type Row = { id: string; status: string; subject: string }
type Call = { tool: string; args: Record<string, unknown>; origin: { plugin: string }; session: string }
type Track = { rows: Row[]; calls: Call[]; order: string[]; failSteps: string | null; failMark: string | null }

/** The Track stand-in, seated beneath the mod; every other tool runs and is recorded in `order`. */
function trackOf(on: any, world: World, rows: Row[] = [{ id: 'plan:1', status: 'completed', subject: 'earlier work' }]): Track {
  world.toolNames = [...TRACK_TOOLS]
  const t: Track = { rows: rows.map(row => ({ ...row })), calls: [], order: [], failSteps: null, failMark: null }
  const checkpoint = () => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: t.rows.length } })
  on('tool.call', (_: unknown, e: any, next: any) => {
    const { tool, tool_use_id: _id, ...args } = e
    t.order.push(tool)
    if (!String(tool).startsWith('mcp__track__')) return { result: 'ran' }
    t.calls.push({ tool, args, origin: next.origin, session: world.sessionId })
    if (tool === 'mcp__track__checkpoint') return { result: JSON.stringify(checkpoint()) }
    if (tool === 'mcp__track__restore_tracker') return { result: JSON.stringify({ ...checkpoint(), destination_session: world.sessionId, applied_checksum: 'a'.repeat(64) }) }
    if (tool === 'mcp__track__lookup_rows') return { result: JSON.stringify({ ok: true, rows: t.rows.map((row, i) => ({ label: `S${i + 1}`, id: row.id, kind: 'step', status: row.status, subject: row.subject })) }) }
    if (tool === STEPS) {
      if (t.failSteps !== null) return { deny: t.failSteps }
      const top = Math.max(0, ...t.rows.map(row => Number(/^plan:(\d+)$/.exec(row.id)?.[1] ?? 0)))
      const added = (args.steps as string[]).map((subject, k) => ({ id: `plan:${top + k + 1}`, status: 'pending', subject }))
      if (args.after === undefined) {
        t.rows = added
        return { result: `Tracking ${added.length} steps: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
      }
      // Track's landed after:'last': the last stored plan row whatever its status; none takes the creation path.
      const anchor = args.after === 'last' ? [...t.rows].reverse().find(row => row.id.startsWith('plan:'))?.id : args.after
      if (args.after === 'last' && anchor === undefined) {
        t.rows.push(...added)
        return { result: `Tracking ${added.length} steps: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
      }
      const i = t.rows.findIndex(row => row.id === anchor)
      if (i < 0) return { result: `No step ${String(args.after)}. Known steps: ${t.rows.map(row => row.id).join(', ')}.` }
      t.rows.splice(i + 1, 0, ...added)
      return { result: `Inserted after ${String(anchor)}: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
    }
    if (tool === MARK) {
      if (t.failMark !== null) return { deny: t.failMark }
      const row = t.rows.find(r => r.id === args.id)
      if (row === undefined) return { result: `No change. Known steps: ${t.rows.map(r => `${r.id} (${r.status})`).join(', ')}.` }
      row.status = String(args.status)
      return { result: `Step ${row.id} "${row.subject}" marked ${row.status}.` }
    }
    return { result: '' }
  })
  return t
}

const writes = (t: Track) => t.calls.filter(c => c.tool === STEPS || c.tool === MARK)
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
/** A real prompt typed over the bound run turn cancels the briefing (a Stop block only re-prompts the run). */
const typedOver = ($: Eng) => $.prompt.submit({ text: 'stop, I need this', wait: true, turnId: 't2', origin: { kind: 'composer' } })

describe('[M1] the automatic route registers and completes its step', () => {
  test('the first snapshot Write registers the step; a queued handoff_now completes it, both in the run turn', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    const write = await writeSnapshot($)
    expect(write.deny, 'the snapshot Write is allowed').toBeUndefined()
    expect(creations(t).map(c => c.args.steps), 'the step is registered at the Write').toEqual([[AUTO_TITLE]])
    const answer = await handoffNow($, RUN_SNAPSHOT)
    expect(String(answer.result)).toContain(HANDOFF_NOW_QUEUED)
    expect(marks(t).map(c => [c.args.id, c.args.status]), 'the step is completed before the run turn ends').toEqual([['plan:2', 'completed']])
    expect(t.rows.find(row => row.id === 'plan:2')).toEqual({ id: 'plan:2', status: 'completed', subject: AUTO_TITLE })
  })
})

describe('[M2] the manual route registers and completes its step', () => {
  test('a validated handoff_now in a typed /compact-crafter turn creates and completes the step before the turn ends', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    mock.clock(on)
    const t = trackOf(on, world)
    await inManualTurn($, world)
    const answer = await handoffNow($, SNAP)
    expect(String(answer.result)).toContain(HANDOFF_NOW_QUEUED)
    expect(creations(t), 'one step is created inside handoff_now').toHaveLength(1)
    const title = String((creations(t)[0]?.args.steps as string[])[0])
    expect(title).toMatch(/^context-handoff: prepare snapshot manual-\S+$/)
    expect(marks(t).map(c => [c.args.id, c.args.status])).toEqual([['plan:2', 'completed']])
  })
})

describe('[M3] a cancelled cycle pauses its step with a note', () => {
  test('a prompt typed over the run turn after the snapshot Write cancels the cycle; the open step is paused, never completed', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    await writeSnapshot($)
    expect(creations(t), 'the step was registered').toHaveLength(1)
    await typedOver($)
    await settle(clock)
    expect(marks(t).map(c => [c.args.id, c.args.status])).toEqual([['plan:2', 'paused']])
    expect(String(marks(t)[0]?.args.note)).toMatch(/cancel/i)
  })
})

describe('[M4] owner switch', () => {
  test('a step registered for one session is never marked once the session has changed', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    await writeSnapshot($)
    expect(creations(t).map(c => c.session), 'registered on the run session\'s rows').toEqual([OLD])
    world.sessionId = NEW
    await typedOver($)
    await settle(clock)
    expect(marks(t).filter(c => c.session !== OLD), 'nothing lands on another session\'s rows').toEqual([])
  })
})

describe('[M5] existing plan preservation', () => {
  test('registration inserts after the last visible step; every prior row is unchanged', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const prior = [{ id: 'plan:1', status: 'completed', subject: 'a' }, { id: 'plan:7', status: 'in_progress', subject: 'b' }, { id: 'plan:3', status: 'paused', subject: 'c' }]
    const t = trackOf(on, world, prior)
    await inRunTurn($, world, clock)
    await writeSnapshot($)
    expect(creations(t).map(c => c.args), 'after the last stored plan row, never a replacement').toEqual([{ steps: [AUTO_TITLE], after: 'last' }])
    await handoffNow($, RUN_SNAPSHOT)
    expect(t.rows.filter(row => row.subject !== AUTO_TITLE)).toEqual(prior)
    expect(marks(t).every(c => !prior.some(row => row.id === c.args.id)), 'no prior row is marked').toBe(true)
  })
})

describe('[M6] model calls are still refused in the run window', () => {
  test('a model (origin engine) track_steps or mark_step call in the run turn is denied and never reaches Track', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    const steps = await $.tool.call({ tool: STEPS, tool_use_id: 'm1', steps: [AUTO_TITLE], after: 'plan:1' })
    const mark = await $.tool.call({ tool: MARK, tool_use_id: 'm2', id: 'plan:1', status: 'completed' })
    expect(String(steps.deny)).toStartWith(RUN_DENY)
    expect(String(mark.deny)).toStartWith(RUN_DENY)
    expect(writes(t)).toEqual([])
  })
})

describe('[M7] exactly one preparation step per cycle', () => {
  test('two snapshot Writes and a queued handoff make one step, completed once, whose result never claims the handoff completed', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    await writeSnapshot($, 'w1')
    await writeSnapshot($, 'w2')
    await handoffNow($, RUN_SNAPSHOT)
    expect(creations(t)).toHaveLength(1)
    expect(marks(t)).toHaveLength(1)
    const result = String(marks(t)[0]?.args.result_text)
    expect(result).toMatch(/verified/)
    expect(result).not.toMatch(/handoff (is )?(complete|completed|done|finished)/i)
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await clock.advance(6_000)
    await settle(clock)
    expect(world.commands, 'the handoff went on').toContain('clear')
    expect(marks(t).filter(c => c.session === OLD), 'the completed step is not touched again').toHaveLength(1)
  })
})

describe('[M8] two-route state', () => {
  test('automatic: the step is created at the snapshot Write, before the Write runs, keyed by the cycle', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    expect(creations(t), 'nothing is registered at the run prompt or turn start').toEqual([])
    await writeSnapshot($)
    expect(t.order.indexOf(STEPS), 'registered before the Write ran').toBeGreaterThanOrEqual(0)
    expect(t.order.indexOf(STEPS)).toBeLessThan(t.order.indexOf('Write'))
    expect(creations(t)[0]?.args.steps).toEqual([AUTO_TITLE])
  })

  test('manual: nothing before handoff_now; create and complete inside it, keyed per handoff_now, before the Stop', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    mock.clock(on)
    const t = trackOf(on, world)
    await inManualTurn($, world)
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: SNAP, content: SNAPSHOT_TEXT() })
    expect(creations(t), 'the manual Write is no boundary').toEqual([])
    await handoffNow($, SNAP)
    expect(writes(t).map(c => c.tool)).toEqual([STEPS, MARK])
    const title = String((creations(t)[0]?.args.steps as string[])[0])
    expect(title).not.toContain(CYCLE)
    expect(title).toContain(`manual-${TURN.turnId}`)
  })
})

describe('[M9] completion only on a verified receipt; cancel pauses; terminal steps untouched', () => {
  test('an invalid snapshot leaves the step open; the later cancel pauses it', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    await writeSnapshot($)
    world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT().replace('Status: partial\n', ''))
    const answer = await handoffNow($, RUN_SNAPSHOT)
    expect(String(answer.result)).toStartWith('snapshot invalid')
    expect(creations(t), 'the step was registered').toHaveLength(1)
    expect(marks(t), 'no completion without a receipt').toEqual([])
    await typedOver($)
    await settle(clock)
    expect(marks(t).map(c => c.args.status)).toEqual(['paused'])
  })

  test('a completed step is not touched when the handoff is cancelled later in its grace', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inManualTurn($, world)
    await handoffNow($, SNAP)
    expect(marks(t).map(c => c.args.status), 'completed on the queue receipt').toEqual(['completed'])
    await $.turn.complete(TURN)
    await clock.settle()
    await $.prompt.submit({ text: 'wait', wait: false, origin: { kind: 'composer' } })
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
    expect(marks(t)).toHaveLength(1)
  })
})

describe('[M10] a failed Track call fails closed, with no retry', () => {
  test('automatic: a refused registration refuses the Write with one line; one attempt only', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    t.failSteps = 'track: injected refusal'
    await inRunTurn($, world, clock)
    const first = await writeSnapshot($, 'w1')
    expect(String(first.deny)).toStartWith(RUN_DENY)
    expect(String(first.deny)).not.toContain('\n')
    expect(t.order, 'the Write never ran').not.toContain('Write')
    const second = await writeSnapshot($, 'w2')
    expect(String(second.deny)).toStartWith(RUN_DENY)
    expect(creations(t), 'no retry').toHaveLength(1)
  })

  test('manual: a refused registration answers not queued, and nothing is queued', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    t.failSteps = 'track: injected refusal'
    await inManualTurn($, world)
    const answer = await handoffNow($, SNAP)
    expect(String(answer.result)).toStartWith('handoff not queued')
    expect(creations(t)).toHaveLength(1)
    await $.turn.complete(TURN)
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
  })

  test('manual: a refused completion answers not queued; no second terminal update', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    t.failMark = 'track: injected refusal'
    await inManualTurn($, world)
    const answer = await handoffNow($, SNAP)
    expect(String(answer.result)).toStartWith('handoff not queued')
    expect(creations(t)).toHaveLength(1)
    expect(marks(t)).toHaveLength(1)
    await $.turn.complete(TURN)
    await clock.advance(7_000)
    expect(world.commands).toEqual([])
    expect(marks(t)).toHaveLength(1)
  })
})

describe('[M11] dispatch sites', () => {
  test('the guard-frame registration reaches Track unguarded; a lifecycle-hook pause passes the own-origin branch; the same call from the model is refused', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    const t = trackOf(on, world)
    await inRunTurn($, world, clock)
    await writeSnapshot($)
    expect(creations(t).map(c => c.origin), 'raised by the mod itself').toMatchObject([OWN_ORIGIN])
    expect(logOf(world), 'the registration skipped the guard (its calling frame)').not.toMatch(/own-track-admitted mcp__track__track_steps/)
    await typedOver($)
    await settle(clock)
    const pause = marks(t)[0]
    expect(pause?.origin).toMatchObject(OWN_ORIGIN)
    expect(logOf(world), 'the prompt.submit-path pause passed the guard\'s own-origin branch').toMatch(/own-track-admitted mcp__track__mark_step/)
    const replay = await $.tool.call({ tool: MARK, tool_use_id: 'm9', ...(pause?.args ?? { id: 'plan:2', status: 'paused' }) })
    expect(String(replay.deny), 'a model-origin call with identical arguments is still refused').toStartWith(RUN_DENY)
    expect(marks(t).filter(c => (c.origin as { plugin: string }).plugin === ENGINE_ORIGIN.plugin)).toEqual([])
  })
})
