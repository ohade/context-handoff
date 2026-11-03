import { fixturePath } from './fixtures/paths'

// Engine tests for the automatic run's binding. Run with
// `claude plugin test <plugin dir>`. At the threshold the plugin runs its packaged skill through
// $.command.run. The kit records that call but starts no turn, so each test raises the live order
// itself: auto-run-called, the call resolves, the plugin's own
// prompt.submit (origin plugin:context-handoff, naming the exact cycle), then turn.start whose text
// is the expanded command markup.
import { describe, expect, mock, test } from 'claude-code/testing'

import { HANDOFF_NOW_QUEUED, HANDOFF_NOW_REFUSAL } from '../hooks/handoff-now'
import { briefOf, logOf, NEW, OLD, packagedScripts, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, SUMMARY, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'

type Eng = any
type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
const TOOL = 'mcp__context-handoff__handoff_now'
const CYCLE = `${OLD}#1`
const OWN = { kind: 'plugin', name: 'context-handoff' }

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

async function typed($: Eng, text: string, turnId = TURN.turnId): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}

async function settle(clock: Clock): Promise<void> {
  await clock.settle()
  await clock.advance(10)
  await clock.settle()
}

/** A typed turn ends over the threshold: the deferred command.run of the skill is called and resolves. */
async function armed($: Eng, world: World, clock: Clock): Promise<void> {
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await startSession($, world)
  await typed($, 'keep going')
  await $.turn.complete(TURN)
  await settle(clock)
  expect(world.commands).toEqual(['context-handoff:compact-crafter'])
}

/** The live order of the run's start: the own prompt.submit with the cycle, then turn.start with the markup. */
async function runTurn($: Eng, turnId = 't2', cycle = CYCLE): Promise<void> {
  await $.prompt.submit({ text: RUN_PROMPT(cycle), wait: false, origin: OWN })
  await $.turn.start({ text: RUN_TURN_TEXT(cycle), turnId })
}

function handoffNow($: Eng, snapshot_path = RUN_SNAPSHOT, tool_use_id = 'tu-run') {
  return $.tool.call({ tool: TOOL, tool_use_id, snapshot_path })
}

/** Index of the first log line containing `needle` (-1 when absent). */
function at(log: string, needle: string): number {
  return log.split('\n').findIndex(l => l.includes(needle))
}

describe('arm', () => {
  test('a turn end over the threshold runs compact-crafter via $.command.run from clock.after(0) with the exact cycle args; origin plugin', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    expect(world.commandRuns[0]?.origin).toEqual(OWN)
    const log = logOf(world)
    expect(log).toContain(` auto-run-called ${CYCLE} command.run(context-handoff:compact-crafter) args="automatic-run cycle=${CYCLE} session=${OLD}"`)
    expect(log).toContain(' auto-run-resolved ')
    // The plugin's own command.run hook is skipped for its own call.
    expect(log).not.toContain('own-command-seen')
  })
})

describe('binding', () => {
  test('live order: resolve, own prompt.submit with the exact cycle, turn.start with the markup binds; handoff_now queues auto; the turn end hands off', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    const answer = await handoffNow($)
    expect(String(answer.result)).toStartWith(HANDOFF_NOW_QUEUED)
    const brief = briefOf(world)
    expect(brief?.path).toMatch(new RegExp(`^${fixturePath('briefs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${OLD}-\\d{8}-\\d{4}-1\\.md$`))
    expect(world.files.get(RUN_SNAPSHOT), 'the skill snapshot is kept beside the brief').toBe(SNAPSHOT_TEXT())
    expect(world.extractorRuns).toHaveLength(1)

    await $.turn.complete({ ...TURN, turnId: 't2' })
    await clock.settle()
    await clock.advance(5_000)
    await clock.advance(1_000)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
    await $.session.end({ reason: 'clear', sessionId: OLD })
    await $.classic.SessionStart({ source: 'clear', session_id: world.sessionId })
    await clock.advance(10)
    expect(world.submits).toHaveLength(1)
    expect(world.submits[0]).toContain(brief?.path.split('/').pop() as string)

    const log = logOf(world)
    const order = [
      ' auto-run-called ', ' auto-run-resolved ', ' prompt-submit-seen origin=plugin:context-handoff ',
      ' turn-start turn t2 origin=own-skill ', ' auto-run-bound ', ' brief-written auto ', ' auto-queued ', ' grace ', ' clear-run ', ' seed-entered ',
    ].map(n => [n, at(log, n)] as const)
    for (const [needle, index] of order) expect([needle, index >= 0]).toEqual([needle, true])
    const indexes = order.map(([, i]) => i)
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
  })

  test('the markup cross-check: an own-skill turn without the markup does not bind; handoff_now there is refused', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await $.prompt.submit({ text: RUN_PROMPT(CYCLE), wait: false, origin: OWN })
    await $.turn.start({ text: 'plain text, no command markup', turnId: 't2' })
    const answer = await handoffNow($)
    expect(answer.result).toBe(HANDOFF_NOW_REFUSAL)
    expect(briefOf(world)).toBeNull()
    expect(logOf(world)).toContain(`auto-run-skip-turn ${CYCLE} turn t2 origin=own-skill markup=false`)
  })

  // This case checks only origin classification: a wrong-cycle submit is not own-skill.
  // Binding and tool authorization are checked separately.
  test('a prompt.submit naming another cycle is not own-skill: its turn starts with origin other', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($, 't2', `${OLD}#7`)
    expect(logOf(world)).toContain(' turn-start turn t2 origin=other ')
    expect(logOf(world)).not.toContain(' turn-start turn t2 origin=own-skill ')
  })

  test('a non-matching turn first (a cron) does not consume the arm; the run turn after it binds and hands off', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await $.turn.start({ text: 'cron: check the build', turnId: 't-cron' })
    expect((await handoffNow($, RUN_SNAPSHOT, 'tu-cron')).result).toBe(HANDOFF_NOW_REFUSAL)
    await $.turn.complete({ ...TURN, turnId: 't-cron' })
    await settle(clock)
    const log = logOf(world)
    expect(log).toContain(`auto-run-skip-turn ${CYCLE} turn t-cron origin=other markup=false`)
    expect(log).toContain(`auto-run-other-turn ${CYCLE} turn t-cron ended; not the run`)
    expect(world.commands, 'no second run, no clear').toEqual(['context-handoff:compact-crafter'])

    await runTurn($)
    expect(String((await handoffNow($)).result)).toStartWith(HANDOFF_NOW_QUEUED)
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await clock.settle()
    await clock.advance(5_000)
    await clock.advance(1_000)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
  })

  test('expiry: no run turn within autoRunTimeoutSeconds is a failed run; no clear; the next threshold turn end backs off', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await clock.advance(180_000)
    expect(logOf(world)).toContain(`auto-run-timeout ${CYCLE} BRIEFING: no run turn started (the arm expired)`)
    await typed($, 'next', 't3')
    await $.turn.complete({ ...TURN, turnId: 't3' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toMatch(/ guard-skip backoff \(failure: /)
  })

  test('a composer prompt during the arm cancels and charges nothing: the next threshold turn end runs again', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await typed($, 'wait, one more thing', 't3')
    expect(logOf(world)).toContain(`cancelled ${CYCLE} BRIEFING: typed-prompt`)
    await $.turn.complete({ ...TURN, turnId: 't3' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'context-handoff:compact-crafter'])
    expect(logOf(world)).toContain(`auto-run-called ${OLD}#2 `)
  })
})

describe('the armed door and the armed window', () => {
  test('handoff_now in the bound turn refuses a snapshot named for another session; nothing is queued', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    const foreign = fixturePath(`briefs/${NEW}-snapshot.md`)
    world.files.set(foreign, SNAPSHOT_TEXT().replace(`session: ${OLD}`, `session: ${NEW}`))
    await runTurn($)
    const answer = await handoffNow($, foreign)
    expect(answer.result).toBe(`snapshot invalid: the file name must start with the current session id ${OLD}`)
    expect(briefOf(world)).toBeNull()
    expect(world.extractorRuns).toEqual([])
  })

  test('the allowlist denies a tool call outside the skill steps in the bound turn, and only there', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await armed($, world, clock)
    await runTurn($)
    const denied = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push origin main' })
    expect(String(denied.deny)).toStartWith('context-handoff automatic run: ')
    expect(logOf(world)).toContain(' auto-run-denied Bash ')
    const read = await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: RUN_SNAPSHOT })
    expect(read.deny).toBeUndefined()
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await settle(clock)
    await typed($, 'hello', 't4')
    const after = await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git push origin main' })
    expect(after.deny, 'outside the run the allowlist does not apply').toBeUndefined()
  })

  test('the tool cap: call autoRunToolCap + 1 is denied and fails the run', async ($, on) => {
    const world = worldOf(on)
    world.env.CONTEXT_HANDOFF_AUTO_RUN_TOOL_CAP = '3'
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await armed($, world, clock)
    await runTurn($)
    for (const id of ['r1', 'r2', 'r3']) expect((await $.tool.call({ tool: 'Read', tool_use_id: id, file_path: RUN_SNAPSHOT })).deny).toBeUndefined()
    const fourth = await $.tool.call({ tool: 'Read', tool_use_id: 'r4', file_path: RUN_SNAPSHOT })
    expect(String(fourth.deny)).toContain('the tool cap (3) is reached')
    expect(logOf(world)).toContain(`auto-run-failed ${CYCLE} BRIEFING: tool cap 3 reached`)
  })
})

describe('session.compact trigger auto', () => {
  test('in IDLE over the threshold it is skipped once and arms the run; the next auto compaction is not skipped', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    const first = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect(String(first.skip)).toContain('running /compact-crafter')
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toContain(`armed-by-compaction ${CYCLE} `)
    const second = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect('skip' in second && second.skip !== undefined).toBe(false)
    expect(world.compactions).toHaveLength(1)
  })

  test('below the threshold it is not skipped and arms nothing', async ($, on) => {
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    await startSession($, world)
    const r = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect('skip' in r && r.skip !== undefined).toBe(false)
    await settle(clock)
    expect(world.commands).toEqual([])
  })
})

describe('W2d: window limits, reload window, loop bound, continuation log', () => {

  test('in the bound turn: --dir only the brief folder; Read only the brief folder, the skill folders and the transcript', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await armed($, world, clock)
    await runTurn($)
    const bash = async (command: string, id: string) => (await $.tool.call({ tool: 'Bash', tool_use_id: id, command })).deny
    expect(String((await handoffNow($)).result)).toStartWith(HANDOFF_NOW_QUEUED)
    const SCRIPTS = packagedScripts(world)
    expect(await bash(`python3 ${SCRIPTS}/snapshot-path.py --session ${OLD} --dir ${fixturePath('briefs')}`, 'b1')).toBeUndefined()
    expect(String(await bash(`python3 ${SCRIPTS}/snapshot-path.py --session ${OLD} --dir ${fixturePath('tmp/x')}`, 'b2'))).toStartWith('context-handoff automatic run: ')
    const read = async (file_path: string, id: string) => (await $.tool.call({ tool: 'Read', tool_use_id: id, file_path })).deny
    expect(await read(TRANSCRIPT, 'r1')).toBeUndefined()
    expect(await read(`${SCRIPTS.slice(0, SCRIPTS.lastIndexOf('/'))}/SKILL.md`, 'r2')).toBeUndefined()
    expect(String(await read(fixturePath('home/.ssh/id_rsa'), 'r3'))).toContain('Read is allowed only under')
    expect(String(await read(fixturePath('briefs/../home/.ssh/id_rsa'), 'r4'))).toContain('Read is allowed only under')
  })

  for (const [name, turnIds] of [['the bound run turn id', ['t2']], ['an unknown run turn id', []]] as const) {
    test(`hot reload during a BRIEFING run with ${name}: the in-flight turn stays on the allowlist until it ends`, async ($, on) => {
      const world = worldOf(on)
      world.env.CONTEXT_HANDOFF_OWNER = '4242:owner-test'
      const clock = mock.clock(on)
      on('tool.call', () => ({ result: 'ran' }))
      const state = {
        version: 1, phase: 'BRIEFING', sessionId: OLD, ownerId: '4242:owner-test', cycleSeq: 1, cycleId: CYCLE,
        enteredAt: 0, deadline: 999_999_999, autoChain: 0, transcriptPath: TRANSCRIPT, loadId: '0-previous-load',
        autoRun: { calledAt: 1, isSubmitSeen: true, turnIds: [...turnIds], isWaiting: false, isStopBlocked: false },
      }
      world.files.set(`${STATE}/sessions/${OLD}.json`, JSON.stringify(state))
      await $.session.start(SESSION_START)
      expect(logOf(world)).toContain(` reload-window run turns [${turnIds.join(',')}]`)
      const denied = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'git push origin main' })
      expect(String(denied.deny)).toStartWith('context-handoff automatic run: ')
      expect((await handoffNow($)).result, 'the door stays closed: the run was reset').toBe(HANDOFF_NOW_REFUSAL)
      await $.turn.complete({ ...TURN, turnId: 't2' })
      await settle(clock)
      const after = await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'git push origin main' })
      expect(after.deny, 'the window ends with the in-flight turn').toBeUndefined()
    })
  }

  test('loop bound: the third automatic run that ends without a clear (typed-prompt cancels) turns the automatic path off with a notice', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    for (const turnId of ['t3', 't4', 't5']) {
      await typed($, 'one more thing', turnId)
      await $.turn.complete({ ...TURN, turnId })
      await settle(clock)
    }
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'context-handoff:compact-crafter', 'context-handoff:compact-crafter'])
    expect(logOf(world)).toMatch(/ guard-skip uncleared-run-cap \(3 automatic runs/)
    expect(world.statuses.some(s => s?.includes('3 automatic runs ended without a clear') && s.includes('handoff.log'))).toBe(true)
  })

  test('[live] a Stop-block continuation logs its turn text; empty and unprompted, it binds', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    world.stopBlock = 'finish the snapshot'
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], transcript_path: TRANSCRIPT })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await settle(clock)
    await $.turn.start({ text: '', turnId: 't3' })
    const log = logOf(world)
    expect(log).toContain(' auto-run-continuation-turn turn t3 prompted=false stopBlocked=true origin=other text="" (0 chars)')
    expect(log).toContain(`auto-run-bound ${CYCLE} turn t3 (continuation)`)
  })
})

describe('W2d r1: handoff_now is never deferred', () => {
  // Live check P1: as an MCP-style tool it was listed behind ToolSearch, which the armed window
  // (correctly) denies, so no automatic run could reach the door.
  test('tool.describe for handoff_now answers isDeferred: false, even when the engine deferred it', async ($, on) => {
    const world = worldOf(on)
    // The engine beneath the mod: an MCP-style tool is listed behind ToolSearch.
    on('tool.describe', (_$: unknown, e: { description: string }) => ({ description: e.description, isDeferred: true }))
    await startSession($, world)
    const described = await $.tool.describe({ tool: TOOL, description: 'Hand this session off.', isDeferred: true, provider: { plugin: 'context-handoff', tier: 'user' } })
    expect(described.isDeferred).toBe(false)
    expect(described.description).toBe('Hand this session off.')
  })
})

// CC-177: a doorbell during the arm is not the user taking over.
const DOORBELL = ': AMQ doorbell run amq drain --include-body then act on it'

describe('CC-177: an AMQ doorbell during the arm', () => {
  test('does not cancel the run', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await $.prompt.submit({ text: DOORBELL, wait: false, origin: { kind: 'composer' } })
    expect(logOf(world)).not.toContain(`cancelled ${CYCLE} BRIEFING: typed-prompt`)
  })

  test('a doorbell typed over the bound run turn does not cancel the briefing', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    await $.prompt.submit({ text: DOORBELL, wait: true, turnId: 't2', origin: { kind: 'composer' } })
    expect(logOf(world)).toContain(' doorbell-seen ')
    expect(logOf(world)).not.toContain(`cancelled ${CYCLE} BRIEFING: typed-prompt`)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a real prompt typed over the bound run turn still cancels the briefing', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    await $.prompt.submit({ text: 'wait, one more thing', wait: true, turnId: 't2', origin: { kind: 'composer' } })
    expect(logOf(world)).toContain(`cancelled ${CYCLE} BRIEFING: typed-prompt`)
  })

  test('after that miss, the next empty turn whose only prompt is a doorbell starts the run', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    await $.prompt.submit({ text: 'wait, one more thing', wait: true, turnId: 't2', origin: { kind: 'composer' } })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toContain(' guard-skip pending-typed-prompt ')
    await $.prompt.submit({ text: DOORBELL, wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: DOORBELL, turnId: 't3' })
    await $.turn.complete({ ...TURN, turnId: 't3' })
    await settle(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'context-handoff:compact-crafter'])
    expect(logOf(world)).not.toContain(' clean-wait pending-typed-prompt ')
  })
})

// TRACK-25 U4: after the run ended (here: its deadline), handoff_now in that run's turn answers the real reason.
describe('TRACK-25 U4: handoff_now after the run ended', () => {
  const TIMED_OUT = 'automatic run timed out after 180 s; stop and print one line'

  test('a timeout in the run turn answers its reason, even with the tool cap reached', async ($, on) => {
    const world = worldOf(on)
    world.env.CONTEXT_HANDOFF_AUTO_RUN_TOOL_CAP = '3'
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'ran' }))
    await armed($, world, clock)
    await runTurn($)
    for (const id of ['r1', 'r2', 'r3']) expect((await $.tool.call({ tool: 'Read', tool_use_id: id, file_path: RUN_SNAPSHOT })).deny).toBeUndefined()
    await clock.advance(180_000)
    expect(logOf(world)).toContain(` auto-run-timeout ${CYCLE} BRIEFING: `)
    const answer = await handoffNow($)
    expect(answer.deny).toBeUndefined()
    expect(answer.result).toBe(TIMED_OUT)
    expect(logOf(world)).toContain(' handoff-now-refused run-ended auto-run-timeout')
    expect(logOf(world)).not.toContain('tool cap 3 reached')
    expect(briefOf(world)).toBeNull()
  })

  test('under the cap the gate refusal is the same reason; a later turn gets the contract refusal', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    await clock.advance(180_000)
    expect((await handoffNow($)).result).toBe(TIMED_OUT)
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await settle(clock)
    await typed($, 'fix the tests', 't3')
    expect((await handoffNow($, RUN_SNAPSHOT, 'tu-later')).result, 'the old run end does not leak into a new turn').toBe(HANDOFF_NOW_REFUSAL)
    expect(briefOf(world)).toBeNull()
  })

  test('with no current turn the answer stays the contract refusal', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await armed($, world, clock)
    await runTurn($)
    await clock.advance(180_000)
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await settle(clock)
    expect((await handoffNow($)).result).toBe(HANDOFF_NOW_REFUSAL)
    expect(logOf(world)).not.toContain('handoff-now-refused run-ended')
  })
})
