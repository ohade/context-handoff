import { fixturePath } from './fixtures/paths'

// FIXTURE: exact response replay and duplicate prevention through native engine calls.
import { expect, mock, test } from 'claude-code/testing'
import { logOf, NEW, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TURN, worldOf as fixtureWorld } from './fixtures/world'

function worldOf(on: Parameters<typeof fixtureWorld>[0]) {
  // FIXTURE: these receipt/recovery cases have an attached display surface.
  on('ui.place', (_$, e) => ({ value: { isPlaced: true, requestId: e.id } }))
  return fixtureWorld(on)
}

const answer = `The result is **ready**.\n\n${'Keep the full response. '.repeat(150)}\nסוף\n`
const notices = (world: ReturnType<typeof worldOf>) => world.notes.filter((row: any) => row.type === 'system') as any[]
const saved = (world: ReturnType<typeof worldOf>) => JSON.parse(world.files.get(`${STATE}/sessions/${NEW}.json`)!)

async function ready($: any, world: ReturnType<typeof worldOf>, clock: any, text = answer) {
  await $.session.start(SESSION_START)
  await $.prompt.submit({ text: 'finish the task', origin: { kind: 'composer' } })
  await $.turn.start({ text: 'finish the task', turnId: 'work' })
  await $.turn.complete({ ...TURN, turnId: 'work', answer: text })
  await clock.advance(10)
  // A child finishing after the main response must not become the replay.
  await $.turn.complete({ ...TURN, turnId: 'child-turn', agentId: 'child', answer: 'Child-only output' })
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 'handoff' })
  await $.tool.call({ tool: 'mcp__context-handoff__handoff_now', snapshot_path: RUN_SNAPSHOT })
  await $.turn.complete({ ...TURN, turnId: 'handoff', answer: 'Handoff snapshot ready.' })
  await clock.advance(10)
}

test('the final main response is displayed in full before the new seed and only once across reload', async ($, on) => {
  let world: ReturnType<typeof worldOf>
  let intent: unknown
  const order: string[] = []
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event === 'prompt.submit' ? ($: any, e: any, next: any) => {
      if (e.origin?.kind === 'plugin' && !e.text.startsWith('/context-handoff:compact-crafter automatic-run ')) order.push('seed')
      return hook($, e, next)
    } : event !== 'session.append' ? hook : async ($: any, e: any, next: any) => {
      if (e.message.type === 'system') intent = saved(world).responseReplay?.status
      const result = await hook($, e, next)
      if (e.message.type === 'system') order.push('notice')
      return result
    })) as typeof on
  world = worldOf(wrapped)
  const clock = mock.clock(on)
  await ready($, world, clock)
  await clock.advance(6_000)
  expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  expect(notices(world).map(row => row.content[0].text)).toEqual([`Previous session response:\n\n${answer}`])
  expect(order).toEqual(['notice', 'seed'])
  expect(intent).toBe('attempted')
  expect(saved(world).responseReplay.status).toBe('shown')
  expect(saved(world).responseReplay.uuid).toBeTruthy()
  expect(world.submits.length).toBe(1)
  await $.session.start(SESSION_START)
  await clock.advance(10)
  expect(notices(world).length).toBe(1)
  expect(world.submits.length).toBe(1)
})

test('a notice stored without a returned receipt is not printed again after reload', async ($, on) => {
  let world: ReturnType<typeof worldOf>
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event !== 'session.append' ? hook : async ($: any, e: any, next: any) => {
      const result = await hook($, e, next)
      if (e.message.type === 'system') await blocked
      return result
    })) as typeof on
  world = worldOf(wrapped)
  const clock = mock.clock(on)
  try {
    await ready($, world, clock)
    await clock.advance(6_000)
    expect(notices(world).length).toBe(1)
    expect(saved(world).responseReplay.status).toBe('attempted')
    await $.session.start(SESSION_START)
    await clock.advance(10)
    expect(saved(world).responseReplay.status).toBe('attempted')
    expect(logOf(world)).toContain('seed-delivery-unknown')
    expect(notices(world).length).toBe(1)
  } finally {
    release()
    await clock.settle()
  }
  expect(notices(world).length).toBe(1)
  expect(saved(world).responseReplay.status).toBe('attempted')
})

for (const startupWins of [false, true]) test(`recovery waits for the replay receipt before submitting the seed (startup wins: ${startupWins})`, async ($, on) => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let releaseSeedCheck!: () => void
  const seedCheckBlocked = new Promise<void>(resolve => { releaseSeedCheck = resolve })
  let holdNextSessionCheck = false
  const order: string[] = []
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event === 'session.id' ? async ($: any, e: any, next: any) => {
      if (holdNextSessionCheck) {
        holdNextSessionCheck = false
        await seedCheckBlocked
      }
      return hook($, e, next)
    } : event === 'prompt.submit' ? ($: any, e: any, next: any) => {
      if (e.origin?.kind === 'plugin') order.push('seed')
      return hook($, e, next)
    } : event !== 'session.append' ? hook : async ($: any, e: any, next: any) => {
      const result = await hook($, e, next)
      if (e.message.type === 'system') {
        // Startup claimed replay while deliverSeed awaited its destination check.
        releaseSeedCheck()
        await blocked
        order.push('notice-receipt')
      }
      return result
    })) as typeof on
  const world = worldOf(wrapped)
  world.env.CONTEXT_HANDOFF_OWNER = '4242:owner-test'
  world.files.set(`${STATE}/sessions/${OLD}.json`, JSON.stringify({
    version: 1, phase: 'CLEARING', sessionId: OLD, ownerId: '4242:owner-test', cycleSeq: 1, cycleId: `${OLD}#1`,
    enteredAt: 0, deadline: 30_000, autoChain: 0, clearingFrom: OLD, briefPath: fixturePath('briefs/b.md'), verifiedCycleId: `${OLD}#1`,
    loadId: '0-previous-load', lastResponse: { sessionId: OLD, turnId: 'work', text: answer },
  }))
  world.sessionId = NEW
  const clock = mock.clock(on)
  try {
    await $.session.start(SESSION_START)
    holdNextSessionCheck = startupWins
    await clock.advance(10)
    expect(notices(world).length).toBe(1)
    expect(world.submits).toEqual([])
  } finally {
    releaseSeedCheck()
    release()
    await clock.settle()
  }
  expect(order).toEqual(['notice-receipt', 'seed'])
  expect(notices(world).length).toBe(1)
  expect(world.submits.length).toBe(1)
  expect(saved(world).responseReplay.status).toBe('shown')
})

test('a refused response notice is reported without stopping the new seed', async ($, on) => {
  const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
    event !== 'session.append' ? hook : ($: any, e: any, next: any) => e.message.type === 'system'
      ? { deny: 'injected: response display refused' } : hook($, e, next))) as typeof on
  const world = worldOf(wrapped)
  const clock = mock.clock(on)
  await ready($, world, clock)
  await clock.advance(6_000)
  expect(logOf(world)).toContain('response-replay-refused')
  expect(logOf(world)).not.toContain('response-replayed')
  expect(notices(world).length).toBe(0)
  expect(world.submits.length).toBe(1)
  expect(saved(world).lastResponse.text).toBe(answer)
})

test('a turn without visible text does not turn the handoff helper response into a replay', async ($, on) => {
  const world = worldOf(on)
  const clock = mock.clock(on)
  await ready($, world, clock, '')
  await clock.advance(6_000)
  expect(notices(world).length).toBe(0)
  expect(world.submits.length).toBe(1)
})
