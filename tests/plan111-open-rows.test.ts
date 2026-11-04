// plan:111, 2026-11-04: an automatic run guessed a truncated waiting-row title. The guess was bound,
// and copying the exact row the refusal then showed counted as a removal, so the run could not clear.
// The mod now writes this session's open waiting/paused rows, complete or typed incomplete, to the
// brief folder before it starts the skill, fenced to the runtime, session and cycle.
import { describe, expect, mock, test } from 'claude-code/testing'

import { BRIEFS, OLD, SESSION_START, SNAPSHOT_TEXT, RUN_SNAPSHOT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'

const ROWS_PATH = `${BRIEFS}/${OLD}-open-rows.json`
const toolNames = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']
const checkpoint = (open_steps: unknown[]) => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: open_steps.length }, open_steps })
const LONG_SUBJECT = 'Intake: uncommitted-skills-gate fails on deleted managed paths (git add pathspec, 95 failures) — root cause and fix proposal; hook edit needs user approval'
/** Twelve open decision rows, more than the refusal hint's ten, each with a title longer than sixty characters. */
const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `plan:${i + 1}`, status: i % 3 === 0 ? 'paused' : 'waiting', subject: `${LONG_SUBJECT} #${i + 1}`, note: `Owner: User; reply "approve ${i + 1}"` }))
const done = { id: 'plan:40', status: 'in_progress', subject: 'Work in flight, not a decision', note: 'Owner: claude' }

type Write = { path: string; commandsBefore: number }

/** world.files that records, for every write, how many commands had been issued before it. */
function recordingFiles(commands: () => string[], writes: Write[]): Map<string, string> {
  return new (class extends Map<string, string> {
    override set(path: string, text: string) {
      writes.push({ path, commandsBefore: commands().length })
      return super.set(path, text)
    }
  })()
}

function setup(on: any, rows: () => unknown[], answer?: () => Promise<unknown>) {
  const writes: Write[] = []
  let world: any
  const files = recordingFiles(() => world?.commands ?? [], writes)
  world = worldOf(on, { toolNames, files })
  const clock = mock.clock(on)
  const calls: string[] = []
  on('tool.call', { tool: /^mcp__track__/ }, async (_: unknown, e: any) => {
    calls.push(e.tool)
    if (answer !== undefined) return answer()
    return { result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(rows()) : { ...checkpoint(rows()), destination_session: 'x', applied_checksum: 'a'.repeat(64) }) }
  })
  return { world, clock, writes, calls }
}

async function settle(clock: any): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

async function typed($: any, text: string, turnId: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}

/** A typed turn ends over the threshold, so the automatic run of cycle #1 is started. */
async function armed($: any, world: any, clock: any): Promise<void> {
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
  await typed($, 'keep going', TURN.turnId)
  await $.turn.complete(TURN)
  await settle(clock)
}

function parsed(world: any): any {
  expect(world.files.has(ROWS_PATH)).toBe(true)
  return JSON.parse(world.files.get(ROWS_PATH) as string)
}
const exact = (row: any) => ({ track_id: row.id, status: row.status, subject: row.subject, note: row.note })

describe('plan:111 open decision rows reach the automatic run before its first snapshot', () => {
  test('every open waiting or paused row, more than ten, is written exactly before the skill command is issued', async ($, on) => {
    const { world, clock, writes } = setup(on, () => [...twelve, done])
    await armed($, world, clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    const write = writes.find(w => w.path === ROWS_PATH)
    expect(write).toBeDefined()
    expect(write?.commandsBefore).toBe(0)
    const record = parsed(world)
    expect(record).toMatchObject({ v: 1, cycle: `${OLD}#1`, session: OLD, complete: true })
    expect(record.rows).toEqual(twelve.map(exact))
  })

  test('a row that does not fit the budget makes the record explicitly incomplete; no row is cut', async ($, on) => {
    const huge = { id: 'plan:13', status: 'waiting', subject: 'Huge decision', note: `Owner: User; ${'x'.repeat(70_000)}` }
    const { world, clock } = setup(on, () => [twelve[1], huge, twelve[2]])
    await armed($, world, clock)
    const record = parsed(world)
    expect(record.complete).toBe(false)
    expect(record.reason).toContain('plan:13')
    expect(record.rows).toEqual([exact(twelve[1]), exact(twelve[2])])
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a failed checkpoint is written as an incomplete record and the run still starts', async ($, on) => {
    const { world, clock } = setup(on, () => [], async () => ({ result: 'not a receipt' }))
    await armed($, world, clock)
    const record = parsed(world)
    expect(record).toMatchObject({ v: 1, cycle: `${OLD}#1`, session: OLD, complete: false, rows: [] })
    expect(typeof record.reason).toBe('string')
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a cycle cancelled while the checkpoint is pending writes nothing and issues no command', async ($, on) => {
    let release: (value: unknown) => void = () => {}
    const pending = new Promise(resolve => { release = resolve })
    const { world, clock, calls } = setup(on, () => [], () => pending)
    await armed($, world, clock)
    expect(calls).toContain('mcp__track__checkpoint')
    await typed($, 'wait, one more thing', 't3')
    release({ result: JSON.stringify(checkpoint(twelve)) })
    await settle(clock)
    expect(world.files.has(ROWS_PATH)).toBe(false)
    expect(world.commands).toEqual([])
  })

  test('a repeated automatic cycle rewrites the record for its own cycle', async ($, on) => {
    let rows: unknown[] = [twelve[0]]
    const { world, clock } = setup(on, () => rows)
    await armed($, world, clock)
    expect(parsed(world).cycle).toBe(`${OLD}#1`)
    await typed($, 'wait, one more thing', 't3')
    rows = [twelve[4]]
    await $.turn.complete({ ...TURN, turnId: 't3' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'context-handoff:compact-crafter'])
    const record = parsed(world)
    expect(record.cycle).toBe(`${OLD}#2`)
    expect(record.rows).toEqual([exact(twelve[4])])
  })
})
