import { fixturePath, protocolPath } from './fixtures/paths'

// Engine tests for the automatic handoff (run with `claude plugin test <mod dir>`).
// W2c: one path. At the threshold the mod runs /compact-crafter itself; the kit starts no turn for
// it, so `runHandsOff` raises the live order: the own prompt.submit naming the
// cycle, the run turn with the command markup, handoff_now with the skill's snapshot, the turn end.
import { describe, expect, mock, test } from 'claude-code/testing'

import { briefOf, logOf, NEW, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, SUMMARY, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'
import { TIMEOUTS_MS } from '../hooks/config'
import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'

type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
type Eng = any
const TOOL = 'mcp__context-handoff__handoff_now'

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

async function typedTurn($: Eng, text: string, turnId: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}

/** A typed turn that ends above the threshold; the deferred command.run of the skill settles. */
async function turnAboveThreshold($: Eng, clock: Clock): Promise<void> {
  await typedTurn($, 'keep going', 't1')
  await $.turn.complete(TURN)
  await clock.settle()
  await clock.advance(10)
}

/** The skill run in the live order: it writes its snapshot, calls handoff_now, and its turn ends. */
async function runHandsOff($: Eng, world: World, clock: Clock): Promise<string> {
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), wait: false, origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  const answer = String((await $.tool.call({ tool: TOOL, tool_use_id: 'tu-run', snapshot_path: RUN_SNAPSHOT })).result)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.settle()
  await clock.advance(10)
  return answer
}

/** Threshold turn end, then the skill run hands off: the cycle is in GRACE. */
async function toGrace($: Eng, world: World, clock: Clock): Promise<void> {
  await turnAboveThreshold($, clock)
  expect(await runHandsOff($, world, clock)).toStartWith(HANDOFF_NOW_QUEUED)
}

async function throughGrace(clock: Clock): Promise<void> {
  await clock.advance(5_000)
  await clock.advance(1_000)
}

async function landClear($: Eng, world: World, clock: Clock): Promise<void> {
  await $.session.end({ reason: 'clear', sessionId: OLD })
  await $.classic.SessionStart({ source: 'clear', session_id: world.sessionId })
  await clock.advance(10)
}

describe('happy path', () => {
  test('skill run, brief, grace, clear, markers under the new id, seed, in order', async ($, on) => {
    const world = worldOf(on)
    world.files.set(protocolPath(`claude-project-${OLD}`), 'sample-project\n')
    world.files.set(protocolPath(`claude-project-verified-${OLD}`), 'sample-project\n')
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)

    // The one run prompt is the test's own live-order submit; it is not counted as a seed.
    expect(world.runPrompts).toEqual([RUN_PROMPT(`${OLD}#1`)])
    expect(world.submits).toEqual([])
    const brief = briefOf(world)
    expect(brief?.path).toMatch(new RegExp(`^${fixturePath('briefs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${OLD}-\\d{8}-\\d{4}-1\\.md$`))
    expect(brief?.text).toContain('mode: continue')
    expect(brief?.text).toContain('## Facts from the transcript')
    expect(world.commands, 'no clear during the grace').toEqual(['context-handoff:compact-crafter'])

    await throughGrace(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])

    await landClear($, world, clock)
    expect(world.files.get(protocolPath(`claude-project-${NEW}`))).toBe('sample-project\n')
    expect(world.files.get(protocolPath(`claude-project-verified-${NEW}`))).toBe('sample-project\n')
    expect(world.submits).toHaveLength(1)
    expect(world.submits[0]).toContain(brief?.path.split('/').pop() as string)
    expect(world.submits[0]).not.toContain('.claude')
    // The replay is person-only; the brief path still rides in one model-only row.
    expect(world.notes.map((note: any) => note.type)).toEqual(['system', 'user'])
    expect(JSON.stringify(world.notes[0])).toContain('Previous session response:')
    expect(JSON.stringify(world.notes[1])).toContain(brief?.path as string)
    expect(logOf(world)).toContain(' seed-note ')

    const log = logOf(world)
    for (const event of ['briefing', 'auto-run-called', 'auto-run-bound', 'brief-written', 'auto-queued', 'grace', 'clearing', 'carrying', 'carried', 'seeding', 'seed-entered', 'handoff-done']) {
      expect([event, log.includes(` ${event} `)]).toEqual([event, true])
    }
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T/m)
  })
})

describe('guards are no-ops', () => {
  const cases: Array<[string, (w: World) => void, string]> = [
    ['tokens unknown', w => { w.tokens = undefined }, 'tokens-unknown'],
    ['draft in the prompt box', w => { w.draft = 'half typed' }, 'draft-in-prompt-box'],
    ['kill switch file', w => { w.files.set(`${STATE}/DISABLED`, '') }, ''],
  ]
  for (const [name, arrange, logged] of cases) {
    test(name, async ($, on) => {
      const world = worldOf(on)
      const clock = mock.clock(on)
      if (name !== 'kill switch file') await startSession($, world)
      arrange(world)
      if (name === 'kill switch file') await startSession($, world)
      await turnAboveThreshold($, clock)
      await throughGrace(clock)
      expect(world.commands).toEqual([])
      if (logged) expect(logOf(world)).toContain(logged)
    })
  }

  test('background tasks from classic.Stop', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await $.session.start(SESSION_START)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'x' }], transcript_path: TRANSCRIPT })
    await turnAboveThreshold($, clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain('background-tasks')
  })
})

describe('inert', () => {
  test('a non-interactive session registers nothing and logs one line', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await $.session.start({ ...SESSION_START, isInteractive: false })
    await turnAboveThreshold($, clock)
    expect(world.tools).toEqual([])
    expect(world.commands).toEqual([])
    expect(logOf(world).trim().split('\n')).toHaveLength(1)
    expect(logOf(world)).toContain('inert not interactive')
  })

  test('a subagent turn end starts nothing', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    await $.turn.complete({ ...TURN, agentId: 'agent-1' })
    await clock.advance(10)
    expect(world.commands).toEqual([])
  })
})

describe('brief failures leave compaction alone', () => {
  test('extractor exit 2: handoff_now queues nothing, the run fails after its wait, compaction stays', async ($, on) => {
    const world = worldOf(on, { extractor: { exitCode: 2, stdout: '' } })
    const clock = mock.clock(on)
    await startSession($, world)
    await turnAboveThreshold($, clock)
    expect(await runHandsOff($, world, clock)).toStartWith('handoff not queued: extractor exit 2')
    await clock.advance(TIMEOUTS_MS.autoRunContinuation + 1_000)
    expect(logOf(world)).toContain('auto-run-timeout')
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(briefOf(world)).toBeNull()
    const compacted = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect('skip' in compacted && compacted.skip !== undefined).toBe(false)
  })
})

describe('veto', () => {
  test('auto compaction is vetoed only during the grace with a verified brief', async ($, on) => {
    // Below the threshold first: in IDLE over it, an auto compaction arms the run instead (auto-run.test.ts).
    const world = worldOf(on, { percent: 12, tokens: 120_000 })
    const clock = mock.clock(on)
    await startSession($, world)
    const before = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect('skip' in before && before.skip !== undefined).toBe(false)
    world.percent = 75
    world.tokens = 750_000
    await toGrace($, world, clock)
    const during = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    expect(during.skip).toContain('context-handoff')
    const manual = await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
    expect('skip' in manual && manual.skip !== undefined).toBe(false)
  })
})

describe('cancel and failures around the clear', () => {
  test('a typed prompt during the grace cancels; no clear', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await $.prompt.submit({ text: 'wait, one more thing', wait: false, origin: { kind: 'composer' } })
    await throughGrace(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toContain('typed-prompt')
  })

  test('a rejected clear resets with a pinned notice', async ($, on) => {
    const world = worldOf(on, { clearRejects: true })
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    expect(logOf(world)).toContain('clear-rejected')
    expect(world.statuses.some(s => s?.includes('run /clear, then press Enter'))).toBe(true)
  })

  test('a clear that never lands ends at the bounded new-id poll with the brief path pinned', async ($, on) => {
    const world = worldOf(on, { clearSwitchesTo: null })
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await clock.advance(31_000)
    expect(logOf(world)).toContain('new-id-missing')
    expect(world.submits).toEqual([])
    expect(stateOf(world).phase).toBe('IDLE')
    expect(world.statuses.some(s => s?.includes(briefOf(world)?.path as string))).toBe(true)
  })
})

describe('seed recovery', () => {
  test('a seed that never runs is filled into the prompt box with a notice', async ($, on) => {
    const world = worldOf(on, { dropPluginPrompts: true })
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await landClear($, world, clock)
    // The SEEDING timeout was raised from 30 s to 120 s after the live test (tests/pure/seed-timeout.spec.ts).
    await clock.advance(TIMEOUTS_MS.seed + 1_000)
    expect(world.fills).toHaveLength(1)
    expect(world.statuses.some(s => s?.includes('press Enter'))).toBe(true)
  })
})

describe('owner stamp', () => {
  test('an owner inherited from another process is not adopted', async ($, on) => {
    const world = worldOf(on)
    world.env.CONTEXT_HANDOFF_OWNER = '1111:parent'
    mock.clock(on)
    await $.session.start(SESSION_START)
    expect(world.env.CONTEXT_HANDOFF_OWNER).toMatch(/^4242:/)
  })
})

describe('Stop re-prompt', () => {
  // In the run turn itself a Stop block continues the run (pure auto-run.spec); after the brief, in
  // GRACE, a block re-prompts work the clear would miss, so it still cancels.
  test('a blocking settings Stop hook during the grace cancels the cycle; no clear', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    world.stopBlock = 'run the tests first'
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], transcript_path: TRANSCRIPT })
    await throughGrace(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toContain('stop-blocked')
  })
})

describe('reload recovery', () => {
  test('a CLEARING file of this process resumes at CARRYING after a reload changed the id', async ($, on) => {
    const world = worldOf(on)
    world.env.CONTEXT_HANDOFF_OWNER = '4242:owner-test'
    const clock = mock.clock(on)
    const state = {
      version: 1, phase: 'CLEARING', sessionId: OLD, ownerId: '4242:owner-test', cycleSeq: 1, cycleId: `${OLD}#1`,
      enteredAt: 0, deadline: 30_000, autoChain: 0, clearingFrom: OLD, briefPath: fixturePath('briefs/b.md'), verifiedCycleId: `${OLD}#1`,
      markers: { project: 'sample-project', verified: 'sample-project' }, hasMarkerSnapshot: true,
      loadId: '0-previous-load', // written by the load before the reload
    }
    world.files.set(`${STATE}/sessions/${OLD}.json`, JSON.stringify(state))
    world.sessionId = NEW
    await $.session.start(SESSION_START)
    await clock.advance(10)
    expect(world.files.get(protocolPath(`claude-project-${NEW}`))).toBe('sample-project\n')
    expect(world.submits).toHaveLength(1)
  })

  test('another process\'s CLEARING file is left alone', async ($, on) => {
    const world = worldOf(on)
    world.env.CONTEXT_HANDOFF_OWNER = '4242:owner-me'
    const clock = mock.clock(on)
    const state = { version: 1, phase: 'CLEARING', sessionId: OLD, ownerId: '9999:owner-other', cycleSeq: 1, cycleId: `${OLD}#1`, enteredAt: 0, deadline: 30_000, autoChain: 0, clearingFrom: OLD }
    world.files.set(`${STATE}/sessions/${OLD}.json`, JSON.stringify(state))
    world.sessionId = NEW
    await $.session.start(SESSION_START)
    await clock.advance(10)
    expect(world.submits).toEqual([])
    expect(world.files.has(protocolPath(`claude-project-${NEW}`))).toBe(false)
  })
})

describe('W7B G1: a definitely dropped seed falls back at once, and the notice follows the fill', () => {
  test('an explicitly dropped seed fills the prompt box now, not after the 120 s seed timeout', async ($, on) => {
    const world = worldOf(on, { dropPluginPrompts: true })
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await landClear($, world, clock)
    await clock.advance(1_000)
    expect(world.submits).toHaveLength(1)
    expect(world.fills, 'filled within a second of the failed submit').toHaveLength(1)
    expect(world.statuses.some(s => s?.includes('press Enter'))).toBe(true)
    expect(logOf(world)).toContain(' seed-stranded ')
  })

  test('when the prompt box could not be filled, the notice does not say "press Enter"', async ($, on) => {
    const world = worldOf(on, { dropPluginPrompts: true })
    world.failing.add('prompt.fill')
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await landClear($, world, clock)
    await clock.advance(1_000)
    const notice = world.statuses.filter(s => s?.startsWith('context-handoff: ')).pop() ?? ''
    expect(notice).not.toContain('press Enter')
    expect(notice).toContain(fixturePath('briefs/'))
    expect(notice).toMatch(/could not be filled/)
  })

  test('a fill that rejects still pins the notice, without "press Enter"', async ($, on) => {
    const world = worldOf(on, { dropPluginPrompts: true })
    world.failing.add('prompt.fill-throws')
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await landClear($, world, clock)
    await clock.advance(1_000)
    expect(logOf(world)).toContain(' seed-fill-failed ')
    const notice = world.statuses.filter(s => s?.startsWith('context-handoff: ')).pop() ?? ''
    expect(notice).toMatch(/could not be filled/)
  })

  test('at the seed timeout too, an unfilled box gets the notice without "press Enter"', async ($, on) => {
    const world = worldOf(on, { dropPluginPrompts: true })
    world.failing.add('prompt.fill')
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await landClear($, world, clock)
    await clock.advance(TIMEOUTS_MS.seed + 1_000)
    expect(world.fills).toHaveLength(1)
    const notice = world.statuses.filter(s => s?.startsWith('context-handoff: ')).pop() ?? ''
    expect(notice).not.toContain('press Enter')
    expect(notice).toMatch(/could not be filled/)
  })
})

describe('W7B M: fault injection on the state file', () => {
  test('a state write that fails once the brief is queued cancels the cycle: no clear', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    await turnAboveThreshold($, clock)
    world.failing.add('state-write')
    await runHandsOff($, world, clock)
    await throughGrace(clock)
    await clock.advance(1_000)
    const log = logOf(world)
    expect(log).toContain(' persist-failed ')
    expect(log).toMatch(/ cancelled .*persist-failed/)
    expect(world.commands).not.toContain('clear')
  })
})

// ---- the Plannotator review guard: written red-first -----------------

const PN_STORE = fixturePath('pn-store')
const PN_FILE = `${PN_STORE}/plannotator_plannotator-test.json`
const PN_GLOB = `${PN_STORE}/plannotator_*.json`

/** Points the mod at a fixture store (read at session start), so no test reads a real one. */
function useStore(world: World): void {
  world.env.CONTEXT_HANDOFF_PLANNOTATOR_STORE_DIR = PN_STORE
}

/** A review launched by `sessionId` and still open: its folder holds stdin and no settled/. */
function openReview(world: World, id = 'pn-1', sessionId = OLD): void {
  world.files.set(PN_FILE, JSON.stringify({ approvals: [], launches: [{ id, sessionId, dir: fixturePath(`pn/${id}`), bridgeToken: 'SECRET' }] }))
  world.files.set(fixturePath(`pn/${id}/stdin`), '{}')
}

function deliverReview(world: World, id = 'pn-1'): void {
  world.files.set(fixturePath(`pn/${id}/settled/delivered`), '1')
}

function stateOf(world: World, sessionId = OLD): { unclearedRuns: number; backoffTokens: number | null; phase: string; deadline: number | null } {
  return JSON.parse(world.files.get(`${STATE}/sessions/${sessionId}.json`) as string)
}

describe('Plannotator review guard', () => {
  test('an open review holds the threshold turn end: no run, nothing charged; once delivered the next turn end hands off', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    openReview(world)
    const clock = mock.clock(on)
    await startSession($, world)
    await turnAboveThreshold($, clock)
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' guard-skip plannotator-review-open (1) at 75%')
    expect(logOf(world)).not.toContain(' briefing ')
    expect(logOf(world)).not.toContain('SECRET')
    expect([stateOf(world).unclearedRuns, stateOf(world).backoffTokens]).toEqual([0, null])

    deliverReview(world)
    await typedTurn($, 'next', 't5')
    await $.turn.complete({ ...TURN, turnId: 't5' })
    await clock.settle()
    await clock.advance(10)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test("another session's open review does not hold the handoff", async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    openReview(world, 'pn-9', NEW)
    const clock = mock.clock(on)
    await startSession($, world)
    await turnAboveThreshold($, clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
  })

  test('a review opened in GRACE cancels the cycle: no clear, counted as an uncleared run', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    expect(stateOf(world).unclearedRuns).toBe(0)
    openReview(world)
    await throughGrace(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toMatch(/ cancelled \S+ GRACE: plannotator-review-open \(1\) at watchdog/)
    expect(stateOf(world).unclearedRuns).toBe(1)
    expect(stateOf(world).phase).toBe('IDLE')
  })

  test('a review that opens as GRACE ends is caught right before the clear: no clear, counted as an uncleared run', async ($, on) => {
    // The kill-switch check opens each watchdog tick. The review appears in it only on the tick that
    // passes the GRACE deadline: that tick moves the cycle to CLEARING, so its own review check is
    // skipped and only the check right before the clear can catch it. The kit takes one hook per op
    // and the world already answers fs.exists, so the world's hook is wrapped as it registers.
    const onWithReview = ((event: string, hook: (...args: any[]) => unknown) =>
      (on as any)(event, event !== 'fs.exists' ? hook : (h$: unknown, e: { path: string }, next: unknown) => {
        const s = world.files.has(`${STATE}/sessions/${OLD}.json`) ? stateOf(world) : null
        if (e.path === `${STATE}/DISABLED` && s?.phase === 'GRACE' && s.deadline !== null && clock.now() >= s.deadline) openReview(world)
        return hook(h$, e, next)
      })) as unknown as typeof on
    const world = worldOf(onWithReview)
    useStore(world)
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await clock.settle()
    expect(world.commands).toEqual(['context-handoff:compact-crafter'])
    expect(logOf(world)).toMatch(/ cancelled \S+ CLEARING: plannotator-review-open \(1\) at clear/)
    expect(logOf(world)).not.toContain('at watchdog')
    expect(stateOf(world).unclearedRuns).toBe(1)
  })

  // amendment A2 says an unknown state holds only at cycle start.
  test('an unknown state in GRACE never cancels: the clear is issued, no notice', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    const clock = mock.clock(on)
    await startSession($, world)
    await toGrace($, world, clock)
    world.files.set(PN_FILE, '{"launches": [')
    await throughGrace(clock)
    expect(world.commands).toEqual(['context-handoff:compact-crafter', 'clear'])
    expect(logOf(world)).not.toContain(' cancelled ')
    expect(world.statuses.filter(s => s?.includes(PN_GLOB))).toHaveLength(0)
  })

  test('in the automatic run, handoff_now with an unknown state still queues and the run reaches GRACE', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    const clock = mock.clock(on)
    await startSession($, world)
    await turnAboveThreshold($, clock)
    world.files.set(PN_FILE, '{"launches": [')
    expect(await runHandsOff($, world, clock)).toStartWith(HANDOFF_NOW_QUEUED)
    expect(stateOf(world).phase).toBe('GRACE')
  })

  test('auto compaction with an open review is not skipped and arms no run', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    openReview(world)
    const clock = mock.clock(on)
    await startSession($, world)
    const compacted = await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
    await clock.settle()
    expect(compacted.skip).toBeUndefined()
    expect(world.commands).toEqual([])
    expect(logOf(world)).toContain(' guard-skip plannotator-review-open (1) at auto compaction')
  })

  test('handoff_now refuses before writing a brief while a review is open, and when the state is unknown', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    openReview(world)
    const clock = mock.clock(on)
    await startSession($, world)
    world.files.set(fixturePath('work/snap.md'), SNAPSHOT_TEXT())
    await typedTurn($, '/compact-crafter', 't1')
    const open = String((await $.tool.call({ tool: TOOL, tool_use_id: 'tu-1', snapshot_path: fixturePath('work/snap.md') })).result)
    expect(open).toBe('handoff not queued: a Plannotator review is open')
    world.files.set(PN_FILE, '{"launches": [')
    const unknown = String((await $.tool.call({ tool: TOOL, tool_use_id: 'tu-2', snapshot_path: fixturePath('work/snap.md') })).result)
    expect(unknown).toBe('handoff not queued: Plannotator state is unknown')
    await clock.settle()
    expect(briefOf(world)).toBeNull()
    expect(world.extractorRuns).toEqual([])
  })

  test('an unknown state on two consecutive checks pins one notice naming the store path', async ($, on) => {
    const world = worldOf(on)
    useStore(world)
    world.files.set(PN_FILE, JSON.stringify({ approvals: [] }))
    const clock = mock.clock(on)
    await startSession($, world)
    await turnAboveThreshold($, clock)
    expect(logOf(world)).toContain(' guard-skip plannotator-state-unknown at 75%')
    expect(world.statuses.filter(s => s?.includes(PN_GLOB))).toHaveLength(0)
    for (const turnId of ['t6', 't7']) {
      await typedTurn($, 'again', turnId)
      await $.turn.complete({ ...TURN, turnId })
      await clock.settle()
      await clock.advance(10)
    }
    const notices = world.statuses.filter(s => s?.includes(PN_GLOB))
    expect(notices).toEqual([`context-handoff: Plannotator state is unknown (no-launches-array), so the handoff waits; store: ${PN_GLOB}`])
    expect(world.commands).toEqual([])
  })
})

describe('restore signal in the seeded session', () => {
  async function toSeed($: Eng, world: World, clock: Clock): Promise<void> {
    await startSession($, world)
    await toGrace($, world, clock)
    await throughGrace(clock)
    await landClear($, world, clock)
    await clock.settle()
    expect(world.submits).toHaveLength(1)
  }

  test('the seeded turn calls restore_tracker: track-restore called', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: 'restored 2 steps' }))
    await toSeed($, world, clock)
    await $.turn.start({ text: world.submits[0], turnId: 't9' })
    await $.tool.call({ tool: 'mcp__track__restore_tracker', tool_use_id: 'tu-r', from_session: OLD })
    await $.turn.complete({ ...TURN, turnId: 't9' })
    await clock.settle()
    expect(logOf(world)).toContain(' track-restore called mcp__track__restore_tracker')
    expect(logOf(world)).not.toContain('track-restore not-called')
  })

  test('the seeded turn ends without either tool: track-restore not-called', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await toSeed($, world, clock)
    await $.turn.start({ text: world.submits[0], turnId: 't9' })
    await $.turn.complete({ ...TURN, turnId: 't9' })
    await clock.settle()
    expect(logOf(world)).toContain(' track-restore not-called')
  })
})
