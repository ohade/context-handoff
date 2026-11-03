import { fixturePath } from './fixtures/paths'

// FIXTURE: TRACK-23, 2026-10-14. A pending-row mismatch was discovered only
// after handoff_now said queued, leaving no repair turn before the clear failed.
import { expect, mock, test } from 'claude-code/testing'
import { NEW, OLD, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, briefOf, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

const TOOL = 'mcp__context-handoff__handoff_now'
const SNAP = fixturePath('snap/pending.md')
const toolNames = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']
const note = 'Owner: User; keep the full blocker. '.repeat(10)
const item = { track_id: 'plan:7', subject: 'Review the change', note, unblock: 'Approve the change', status: 'paused' }
const row = { id: item.track_id, subject: item.subject, note, status: item.status }
const checkpoint = (rows: unknown[]) => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: rows.length }, open_steps: rows })
const snapshot = () => SNAPSHOT_TEXT().replace('## 3. Pending, owned by the user\n- none', `## 3. Pending, owned by the user\n- Pending: ${JSON.stringify(item)}`)

async function start($: any, world: World) {
  world.files.set(SNAP, snapshot())
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
  await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
}

test('a pending mismatch is returned before queuing; repairing the actual row permits a fresh attempt', async ($, on) => {
  const world = worldOf(on, { toolNames, percent: 12, tokens: 120_000 })
  const clock = mock.clock(on)
  let rows = [{ ...row, note: 'Outdated blocker' }]
  const calls: string[] = []
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => {
    calls.push(e.tool)
    return { result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(rows) : { ...checkpoint(rows), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }
  })
  await start($, world)
  const refused = await $.tool.call({ tool: TOOL, snapshot_path: SNAP })
  expect(String(refused.result)).toContain('snapshot invalid: pending: plan:7')
  expect(briefOf(world)).toBeNull()
  expect(world.extractorRuns).toHaveLength(0)
  expect(world.commands).toEqual([])
  expect(calls).toEqual(['mcp__track__checkpoint'])

  rows = [row]
  const accepted = await $.tool.call({ tool: TOOL, snapshot_path: SNAP })
  expect(String(accepted.result)).toContain('handing off at the end of this turn')
  await $.turn.complete(TURN)
  await clock.advance(7_000)
  expect(world.commands).toEqual(['clear'])
  expect(world.sessionId).toBe(NEW)
  expect(calls).toEqual(['mcp__track__checkpoint', 'mcp__track__checkpoint', 'mcp__track__checkpoint', 'mcp__track__restore_tracker'])
  expect(briefOf(world)?.text).toContain(JSON.stringify(item))
})

test('successful preflight never substitutes for the final checkpoint after a row changes', async ($, on) => {
  const world = worldOf(on, { toolNames, percent: 12, tokens: 120_000 })
  const clock = mock.clock(on)
  let rows = [row]
  let checkpoints = 0
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => {
    if (e.tool === 'mcp__track__checkpoint') checkpoints++
    return { result: JSON.stringify(checkpoint(rows)) }
  })
  await start($, world)
  const answer = await $.tool.call({ tool: TOOL, snapshot_path: SNAP })
  expect(String(answer.result)).toContain('handing off at the end of this turn')
  expect(checkpoints).toBe(1)
  rows = [{ ...row, note: 'A newer blocker' }]
  await $.turn.complete(TURN)
  await clock.advance(7_000)
  expect(checkpoints).toBe(2)
  expect(world.sessionId).toBe(OLD)
  expect(world.commands).toEqual([])
  expect(world.submits).toEqual([])
})
