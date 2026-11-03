import { fixturePath } from './fixtures/paths'

// FIXTURE: the world models ordinary command hooks independently of classic events.
import { expect, mock, test } from 'claude-code/testing'
import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { briefOf, logOf, NEW, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TRANSCRIPT, TURN, worldOf } from './fixtures/world'

async function grace($: any, world: any, clock: any, initializeClassic = false) {
  await $.session.start(SESSION_START)
  if (initializeClassic) await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: OLD })
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(10)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  const result = await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  expect(String(result.result)).toStartWith(HANDOFF_NOW_QUEUED)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(10)
}

test('ordinary relay alone supports brief, clear, new-id polling and seed without any classic event', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await grace($, world, clock)
  await clock.advance(6_000)
  expect(world.sessionId).toBe(NEW)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(world.submits).toHaveLength(1)
  expect(world.submits[0]).toContain(briefOf(world)?.path.split('/').pop())
  expect(logOf(world)).toContain(' handoff-done ')
})

test('missing Stop observations cannot start the automatic run', async ($, on) => {
  const world = worldOf(on, { relayOnStop: false })
  const clock = mock.clock(on)
  await $.session.start(SESSION_START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.advance(1_000)
  expect(world.commands).toEqual([])
  expect(logOf(world)).toContain('activity-unknown')
})

for (const mismatch of ['owner', 'generation', 'session_id']) {
  test(`a ${mismatch} mismatch in the final observation prevents clear`, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await grace($, world, clock, true)
    const path = `${STATE}/relay/${OLD}.json`
    const record = JSON.parse(world.files.get(path)!)
    record[mismatch] = 'another-observation'
    world.files.set(path, JSON.stringify(record))
    await clock.advance(6_000)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(world.submits).toEqual([])
    expect(logOf(world)).toContain('activity-unknown')
    expect(JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`)!).phase).toBe('IDLE')
  })
}

test('a native event invalidates an older idle observation before clearing', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: 'ok' }))
  await grace($, world, clock, true)
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.submits).toEqual([])
  expect(logOf(world)).toContain('activity-unknown')
})

test('a draft entered during grace prevents clearing and remains intact', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await grace($, world, clock, true)
  world.draft = 'unfinished draft 👋 שלום'
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(world.draft).toBe('unfinished draft 👋 שלום')
  expect(world.submits).toEqual([])
  expect(JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`)!).phase).toBe('IDLE')
})

test('overlapping native calls cannot leave the Stop relay stamped with an older generation', async ($, on) => {
  let delay = false
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event !== 'env.set' ? hook : async ($: any, e: any, next: any) => {
      if (delay && e.name === 'CONTEXT_HANDOFF_ACTIVITY_GENERATION') {
        delay = false
        started()
        await blocked
      }
      return hook($, e, next)
    })) as typeof on
  const world = worldOf(wrapped)
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start(SESSION_START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  delay = true
  const first = $.tool.call({ tool: 'Read', file_path: fixturePath('one') })
  await entered
  const second = $.tool.call({ tool: 'Read', file_path: fixturePath('two') })
  // The second call need not finish first; this releases the first write after
  // any immediately available second write has had a chance to run.
  await clock.settle()
  release()
  await Promise.all([first, second])
  // Load, turn start and the two calls produce revisions 1 through 4.
  // Revision 3 finishing last must not overwrite revision 4 in the child env.
  expect(world.env.CONTEXT_HANDOFF_ACTIVITY_GENERATION).toEndWith(':4')
  await $.turn.complete(TURN)
  await clock.advance(800)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(logOf(world)).not.toContain('activity-unknown')
})

test('a matching Stop relay arriving after 800 ms still permits handoff within its hook budget', async ($, on) => {
  const world = worldOf(on, { relayOnStop: false })
  const clock = mock.clock(on)
  await $.session.start(SESSION_START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const record = { v: 1, event: 'Stop', session_id: OLD, owner: world.env.CONTEXT_HANDOFF_OWNER,
    generation: world.env.CONTEXT_HANDOFF_ACTIVITY_GENERATION, observed_at: 800,
    transcript_path: TRANSCRIPT, background_tasks: [], session_crons: [] }
  await $.turn.complete(TURN)
  await clock.advance(800)
  world.files.set(`${STATE}/relay/${OLD}.json`, JSON.stringify(record))
  await clock.advance(200)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
})

test('known busy work at the final check is identified as busy and retains context', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await grace($, world, clock, true)
  const path = `${STATE}/relay/${OLD}.json`
  const record = JSON.parse(world.files.get(path)!)
  record.background_tasks = [{ id: 'busy', type: 'shell', status: 'running' }]
  world.files.set(path, JSON.stringify(record))
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  expect(logOf(world)).toContain(' activity-busy ')
  expect(logOf(world)).not.toContain(' activity-unknown ')
  expect(JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`)!).phase).toBe('IDLE')
})
