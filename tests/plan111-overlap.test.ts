// plan:111 overlap, 2026-11-04: a cycle-1 open-rows write that was still in flight when cycle 2
// started landed last and replaced cycle 2's record. This pin does not name the file: it reads every
// open-rows record of the session and requires the cycle-2 record to survive the late cycle-1 write.
import { expect, mock, test } from 'claude-code/testing'

import { BRIEFS, OLD, RUN_SNAPSHOT, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, worldOf } from './fixtures/world'

const PREFIX = `${BRIEFS}/${OLD}-open-rows`
const toolNames = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']
const checkpoint = (open_steps: unknown[]) => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: open_steps.length }, open_steps })
const LONG = 'Intake: uncommitted-skills-gate fails on deleted managed paths (git add pathspec, 95 failures) — root cause and fix proposal'
const first = { id: 'plan:1', status: 'waiting', subject: `${LONG} #1`, note: 'Owner: User; reply "approve 1"' }
const second = { id: 'plan:5', status: 'paused', subject: `${LONG} #5`, note: 'Owner: User; parked until the release' }

/** Every open-rows record of this session, in any file whose name starts with the session's prefix. */
function records(world: any): any[] {
  return [...world.files.entries()].filter(([path]: [string, string]) => path.startsWith(PREFIX) && path.endsWith('.json')).map(([, text]: [string, string]) => JSON.parse(text))
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

test('a cycle-1 open-rows write that lands after cycle 2 started leaves the cycle-2 record intact', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  let rows: unknown[] = [first]
  on('tool.call', { tool: /^mcp__track__/ }, (_: unknown, e: any) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(rows) : { ...checkpoint(rows), destination_session: 'x', applied_checksum: 'a'.repeat(64) }) }))
  let release: () => void = () => {}
  const hold = new Promise<void>(resolve => { release = resolve })
  // Hold the first open-rows write of the session, whatever its file name.
  const files = world.files
  const holds = new Map<string, Promise<void>>()
  world.writeHolds = new Proxy(holds, {
    get(target, key) {
      if (key === 'get') return (path: string) => (path.startsWith(PREFIX) && !held ? (held = true, hold) : undefined)
      if (key === 'delete') return () => true
      return Reflect.get(target, key)
    },
  }) as Map<string, Promise<void>>
  let held = false

  files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
  await typed($, 'keep going', TURN.turnId)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(held).toBe(true)
  expect(records(world)).toEqual([])

  await typed($, 'wait, one more thing', 't3')
  rows = [second]
  await $.turn.complete({ ...TURN, turnId: 't3' })
  await settle(clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])

  release()
  await settle(clock)
  const cycle2 = records(world).filter(record => record.cycle === `${OLD}#2`)
  expect(cycle2).toEqual([{ v: 1, cycle: `${OLD}#2`, session: OLD, complete: true, rows: [{ track_id: second.id, status: second.status, subject: second.subject, note: second.note }] }])
})
