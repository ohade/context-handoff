// FIXTURE: supported mechanical calls, never private Track storage.
import { expect, mock, test } from 'claude-code/testing'
import { OLD, NEW, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TURN, worldOf } from './fixtures/world'

const checkpoint = { v: 1, ok: true, source_session: OLD, revision: 3, checksum: 'a'.repeat(64), counts: { questions: 2, answers: 1, steps: 3 } }
const ready = async ($: any, world: any, clock: any) => {
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(6_000)
}
const toolNames = ['mcp__track__checkpoint', 'mcp__track__restore_tracker']

test('a checkpoint receipt is required before clear and validated restoration precedes the seed', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  const calls: any[] = []
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => {
    calls.push({ ...e, session: world.sessionId })
    return { result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint : { ...checkpoint, destination_session: NEW, applied_checksum: checkpoint.checksum, counts: checkpoint.counts }) }
  })
  await ready($, world, clock)
  expect(calls.map(c => c.tool)).toEqual(['mcp__track__checkpoint', 'mcp__track__restore_tracker'])
  expect(calls[0]).toMatchObject({ expected_session: OLD, session: OLD })
  expect(calls[1]).toMatchObject({ from_session: OLD, session: NEW, expected_checkpoint: checkpoint })
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(world.submits).toHaveLength(1)
  expect(JSON.stringify(world.notes)).toContain('Verified Track restore receipt:')
  expect(JSON.stringify(world.notes)).toContain(checkpoint.checksum)
})

for (const [name, value] of [
  ['failed', { ...checkpoint, ok: false, reason: 'unsaved' }],
  ['incompatible', { ...checkpoint, v: 99 }],
  ['wrong-session', { ...checkpoint, source_session: NEW }],
] as const) {
  test(`${name} checkpoint gets two attempts total and leaves the old context`, async ($, on) => {
    const world = worldOf(on, { toolNames })
    const clock = mock.clock(on)
    let attempts = 0
    on('tool.call', { tool: /^mcp__track__/ }, () => { attempts++; return { result: JSON.stringify(value) } })
    await ready($, world, clock)
    expect(attempts).toBe(2)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(world.sessionId).toBe(OLD)
    expect(JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`) ?? '{}').phase).toBe('IDLE')
    expect(world.statuses.join(' ')).toMatch(/checkpoint/i)
  })
}

test('Track absent keeps handoff independently usable', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await ready($, world, clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(world.submits).toHaveLength(1)
})

test('restoration refusal holds continuation and preserves a concrete recovery instruction', async ($, on) => {
  const world = worldOf(on, { toolNames })
  const clock = mock.clock(on)
  on('tool.call', { tool: /^mcp__track__/ }, (_, e) => e.tool === 'mcp__track__checkpoint' ? { result: JSON.stringify(checkpoint) } : { deny: 'native permission refusal' })
  await ready($, world, clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(world.submits).toHaveLength(0)
  expect(world.statuses.join(' ')).toContain('restore_tracker')
  expect(world.statuses.join(' ')).toContain('native permission refusal')
})

for (const [name, restored] of [
  ['wrong destination', { ...checkpoint, destination_session: OLD, applied_checksum: checkpoint.checksum }],
  ['different restored values', { ...checkpoint, destination_session: NEW, applied_checksum: 'b'.repeat(64) }],
] as const) {
  test(`${name} cannot release the continuation seed`, async ($, on) => {
    const world = worldOf(on, { toolNames })
    const clock = mock.clock(on)
    on('tool.call', { tool: /^mcp__track__/ }, (_, e) => ({ result: JSON.stringify(e.tool === 'mcp__track__checkpoint' ? checkpoint : restored) }))
    await ready($, world, clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
    expect(world.submits).toHaveLength(0)
    expect(world.statuses.join(' ')).toMatch(/restore/i)
  })
}
