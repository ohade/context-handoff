import { fixturePath } from './fixtures/paths'

// FIXTURE: CC-181, 2026-10-10. Four pending decisions survived as prose but
// had no Track rows. Validate declared references at the last checkpoint, before clear.
import { expect, mock, test } from 'claude-code/testing'
import { OLD, NEW, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, TURN, briefOf, logOf, worldOf } from './fixtures/world'

const toolNames = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']
const pending = ['Retention decision', 'Tracker decision', 'Release decision', 'Performance decision'].map((subject, i) => ({
  track_id: `plan:${76 + i}`, subject, note: 'Owner: User; needs a decision', unblock: `Decide ${subject}`,
}))
const existing = { id: 'plan:28', subject: 'Canary', status: 'paused', note: 'Unassigned backlog' }
const openRows = () => [existing, ...pending.map(p => ({ id: p.track_id, subject: p.subject, status: 'waiting', note: p.note }))]
const checkpoint = (open_steps: unknown) => ({ v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: 5 }, open_steps })
const snapshot = (items: unknown[] = pending) => SNAPSHOT_TEXT().replace('## 3. Pending, owned by the user\n- none', `## 3. Pending, owned by the user\n${items.map(item => `- Pending: ${JSON.stringify(item)}`).join('\n')}`)
const ready = async ($: any, world: any, clock: any, text = snapshot(), beforeCheckpoint = () => {}) => {
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  world.files.set(RUN_SNAPSHOT, text)
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  const answer = await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  beforeCheckpoint()
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(6_000)
  return answer
}

test('one open row cannot certify four unmatched pending decisions or clear the context', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint([existing]) : { ...checkpoint([existing]), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }))
  const answer = await ready($, world, clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.sessionId).toBe(OLD)
  expect(String(answer.result)).toContain('snapshot invalid: pending: plan:76')
  expect(String(answer.result)).toContain('before handoff')
})

test('registered decisions permit handoff with all five open rows and no registration calls in the automatic run', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  const calls: string[] = []
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => {
    calls.push(e.tool)
    return { result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(openRows()) : { ...checkpoint(openRows()), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }
  })
  await ready($, world, clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  // plan:111: run-start open-rows read, preflight, final receipt, then restore.
  expect(calls).toEqual(['mcp__track__checkpoint', 'mcp__track__checkpoint', 'mcp__track__checkpoint', 'mcp__track__restore_tracker'])
  const section = briefOf(world)!.text.split('## 3. Pending, owned by the user\n')[1]!.split('\n## 4.')[0]!
  expect(section.split('\n').filter(line => line.startsWith('- Pending: '))).toHaveLength(4)
  expect(section).toContain('Release decision')
  expect(section).toContain('Performance decision')
  expect(JSON.stringify(world.notes)).toContain('plan:28')
  for (const item of pending) expect(JSON.stringify(world.notes)).toContain(item.track_id)
  expect(JSON.stringify(world.notes)).toContain('Verified Track restore receipt')
})

for (const [name, transform] of [
  ['completed', (row: any) => ({ ...row, status: 'completed' })],
  ['cleared', (row: any) => ({ ...row, cleared: true })],
  ['wrong status', (row: any) => ({ ...row, status: 'paused' })],
  ['unrelated title', (row: any) => ({ ...row, subject: 'Other work' })],
  ['stale blocker', (row: any) => ({ ...row, note: 'New owner or blocker' })],
] as const) {
  test(`${name} pending reference cannot release clear`, async ($, on) => {
    const world = worldOf(on, { toolNames })
    const clock = mock.clock(on)
    const rows = openRows().map(row => row.id === 'plan:76' ? transform(row) : row)
    on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(rows) : { ...checkpoint(rows), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }))
    await ready($, world, clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(world.submits).toHaveLength(0)
  })
}

test('a blocker changed after brief creation is checked at the final checkpoint, not against earlier coverage', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  let rows = openRows()
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(rows) : { ...checkpoint(rows), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }))
  await ready($, world, clock, snapshot(), () => { rows = rows.map(row => row.id === 'plan:76' ? { ...row, note: 'Changed after the brief was written' } : row) })
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.sessionId).toBe(OLD)
})

test('the legacy three-bullet prose cannot claim four pending items are covered by Track', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(openRows()) : { ...checkpoint(openRows()), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }))
  await ready($, world, clock, SNAPSHOT_TEXT().replace('## 3. Pending, owned by the user\n- none', '## 3. Pending, owned by the user\n- Retention decision\n- Tracker decision\n- Release decision and Performance decision'))
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.submits).toHaveLength(0)
})

test('Track absence preserves declared pending notes but explicitly claims no Track coverage', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await ready($, world, clock, snapshot(pending.map(p => ({ ...p, track_id: null }))))
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(JSON.stringify(world.notes)).toContain('Track absent; pending items are notes only, with no verified Track coverage')
  expect(briefOf(world)!.text).toContain('Retention decision')
  expect(JSON.stringify(world.notes)).not.toContain('Verified Track restore receipt')
})

test('unknown checkpoint inventory cannot certify pending coverage', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(undefined) : { ...checkpoint(undefined), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }))
  await ready($, world, clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
})

test('an unrelated multiword TodoWrite row does not prevent a handoff without declared pending items', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  const rows = [{ id: 'todo:review patch', subject: 'Review patch', status: 'pending' }]
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(rows) : { ...checkpoint(rows), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }))
  await ready($, world, clock, SNAPSHOT_TEXT())
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(world.sessionId).toBe(NEW)
})

for (const guard of ['draft', 'kill-switch', 'review'] as const) {
  test(`${guard} changed during a stalled final checkpoint still prevents clear`, async ($, on) => {
    const world = worldOf(on, { toolNames })
    const clock = mock.clock(on)
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    let checkpoints = 0
    on('tool.call', { tool: /^mcp__track__/ }, async (_, e) => {
      // TRACK-23 adds preflight. This race still targets the final check.
      if (e.tool === 'mcp__track__checkpoint' && ++checkpoints === 3) { // plan:111: 1 run-start read, 2 preflight, 3 final
        started()
        await blocked
      }
      return { result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint(openRows()) : { ...checkpoint(openRows()), destination_session: NEW, applied_checksum: 'a'.repeat(64) }) }
    })
    await ready($, world, clock)
    await entered
    if (guard === 'draft') world.draft = 'Keep this typed draft'
    if (guard === 'kill-switch') world.files.set(fixturePath('state/DISABLED'), '')
    if (guard === 'review') {
      world.files.set(fixturePath('home/.claude/plugins/store/plannotator_test.json'), JSON.stringify({ launches: [{ id: 'review-1', sessionId: OLD, dir: fixturePath('pn/review-1') }] }))
      world.files.set(fixturePath('pn/review-1/stdin'), '{}')
    }
    release()
    await clock.settle()
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(world.sessionId).toBe(OLD)
    expect(logOf(world) + world.statuses.join(' ')).toContain(guard === 'draft' ? 'draft-in-prompt-box' : guard === 'review' ? 'review' : 'kill-switch')
  })
}
