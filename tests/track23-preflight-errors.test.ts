import { fixturePath } from './fixtures/paths'

// FIXTURE: TRACK-23 review, 2026-10-15. A tool or session failure must not
// tell the caller to edit an otherwise valid snapshot and retry it.
import { expect, mock, test } from 'claude-code/testing'
import { NEW, OLD, SESSION_START, SNAPSHOT_TEXT, TRANSCRIPT, TURN, briefOf, worldOf } from './fixtures/world'

const SNAP = fixturePath('snap/pending.md')
const item = { track_id: 'plan:7', subject: 'Review', note: 'Needs the owner', unblock: 'Owner replies', status: 'paused' }
const checkpoint = { v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: 1 }, open_steps: [{ id: item.track_id, subject: item.subject, note: item.note, status: item.status }] }

for (const failure of ['refusal', 'exception', 'session change'] as const) {
  test(`preflight ${failure} reports handoff unavailable without blaming the snapshot`, async ($, on) => {
    const world = worldOf(on, { toolNames: ['mcp__track__checkpoint', 'mcp__track__restore_tracker'], percent: 12, tokens: 120_000 })
    mock.clock(on)
    world.files.set(SNAP, SNAPSHOT_TEXT().replace('## 3. Pending, owned by the user\n- none', `## 3. Pending, owned by the user\n- Pending: ${JSON.stringify(item)}`))
    on('tool.call', { tool: 'mcp__track__checkpoint' }, () => {
      if (failure === 'exception') throw new Error('Storage unavailable')
      if (failure === 'session change') world.sessionId = NEW
      return { result: JSON.stringify(failure === 'refusal' ? { ...checkpoint, ok: false, reason: 'Storage unavailable' } : checkpoint) }
    })
    await $.session.start(SESSION_START)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
    await $.prompt.submit({ text: '/compact-crafter', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: '/compact-crafter', turnId: TURN.turnId })
    const answer = String((await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: SNAP })).result)
    expect(answer).toStartWith('handoff not queued: ')
    expect(answer).toContain(failure === 'session change' ? 'preflight session changed' : 'Track preflight failed:')
    expect(answer).not.toContain('snapshot invalid:')
    expect(answer).not.toContain('pending:')
    expect(briefOf(world)).toBeNull()
    expect(world.extractorRuns).toHaveLength(0)
    expect(world.commands).toEqual([])
  })
}
