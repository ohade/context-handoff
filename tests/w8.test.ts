// Detached poll/watchdog failures must be reported and end the cycle rather than stall CLEARING.
// Stale session files are pruned at load. Run with `claude plugin test <plugin dir>`.
import { describe, expect, mock, test } from 'claude-code/testing'

import { logOf, OLD, RUN_PROMPT, RUN_SNAPSHOT, RUN_TURN_TEXT, SESSION_START, SNAPSHOT_TEXT, STATE, TRANSCRIPT, TURN, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'
import { HANDOFF_NOW_QUEUED } from '../hooks/handoff-now'
import { TIMEOUTS_MS } from '../hooks/config'

type Clock = { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }
type Eng = any
const TOOL = 'mcp__context-handoff__handoff_now'
const DAY = 86_400_000

async function startSession($: Eng, world: World): Promise<void> {
  await $.session.start(SESSION_START)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], transcript_path: TRANSCRIPT, session_id: world.sessionId })
}

/** Threshold turn end, the skill run hands off, the grace runs out: the clear is issued (CLEARING). */
async function toClearing($: Eng, world: World, clock: Clock): Promise<void> {
  await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'keep going', turnId: 't1' })
  await $.turn.complete(TURN)
  await clock.settle()
  await clock.advance(10)
  world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
  await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), wait: false, origin: { kind: 'plugin', name: 'context-handoff' } })
  await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
  expect(String((await $.tool.call({ tool: TOOL, tool_use_id: 'tu-run', snapshot_path: RUN_SNAPSHOT })).result)).toStartWith(HANDOFF_NOW_QUEUED)
  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.settle()
  await clock.advance(10)
  await clock.advance(5_000)
  await clock.advance(1_000)
}

describe('[B2] the detached loops report a failure instead of dying silently', () => {
  test('a session id probe that rejects during the new-id poll ends the cycle at once, with the reason', async ($, on) => {
    const world = worldOf(on, { clearSwitchesTo: null })
    const clock = mock.clock(on)
    await startSession($, world)
    await toClearing($, world, clock)
    expect(logOf(world)).toContain(' clear-run ')
    await $.session.end({ reason: 'clear', sessionId: OLD })
    await $.classic.SessionStart({ source: 'clear', session_id: OLD })
    expect(logOf(world)).toContain(' new-id-poll ')
    world.failing.add('session.id')
    await clock.advance(300)
    await clock.settle()
    const log = logOf(world)
    expect(log).toContain(' poll-new-id-failed ')
    expect(log).toContain(' new-id-missing ')
    expect(log).toContain('injected: session.id')
    expect(log).not.toContain(' clear-timeout ')
  })

  test('a watchdog tick whose kill-switch check rejects is logged, and the new-id deadline still runs', async ($, on) => {
    const world = worldOf(on, { clearSwitchesTo: null })
    const clock = mock.clock(on)
    await startSession($, world)
    await toClearing($, world, clock)
    world.failing.add('kill-switch-check')
    await clock.advance(31_000)
    await clock.settle()
    const log = logOf(world)
    expect(log).toContain(' watchdog-failed ')
    expect(log).toContain('injected: kill switch check')
    expect(log).toContain(' new-id-missing ')
    expect(world.submits).toEqual([])
    expect(JSON.parse(world.files.get(`${STATE}/sessions/${OLD}.json`)!).phase).toBe('IDLE')
  })
})

describe('[E] stale session files are pruned at load', () => {
  test('files untouched for 30 days go, recent ones and the own file stay, and the load says how many', async ($, on) => {
    const now = 40 * DAY
    const world = worldOf(on)
    const stale = [`${STATE}/sessions/33333333-aaaa-4bbb-8ccc-000000000003.json`, `${STATE}/sessions/44444444-aaaa-4bbb-8ccc-000000000004.json`]
    const recent = `${STATE}/sessions/55555555-aaaa-4bbb-8ccc-000000000005.json`
    const own = `${STATE}/sessions/${OLD}.json`
    for (const path of [...stale, recent, own]) world.files.set(path, '{}')
    for (const path of [...stale, own]) world.mtimes.set(path, 0)
    world.mtimes.set(recent, now - DAY)
    const clock = mock.clock(on, { now })
    await startSession($, world)
    await clock.settle()
    await clock.advance(10)
    expect([...world.removed].sort()).toEqual([...stale].sort())
    expect(world.files.has(recent)).toBe(true)
    expect(logOf(world)).toContain(' sessions-pruned 2 ')
  })
})

describe('[W8 r1] narrower failure handling', () => {
  test('a kill-switch check that rejects during the grace reads as on: no clear is issued', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: 't1' })
    await $.turn.complete(TURN)
    await clock.settle()
    await clock.advance(10)
    world.files.set(RUN_SNAPSHOT, SNAPSHOT_TEXT())
    await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), wait: false, origin: { kind: 'plugin', name: 'context-handoff' } })
    await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu-run', snapshot_path: RUN_SNAPSHOT })
    await $.turn.complete({ ...TURN, turnId: 't2' })
    await clock.settle()
    await clock.advance(10)
    expect(logOf(world)).toContain(' grace ')
    world.failing.add('kill-switch-check')
    await clock.advance(6_000)
    await clock.settle()
    const log = logOf(world)
    expect(log).toContain(' watchdog-failed ')
    expect(log).toMatch(/ cancelled .*kill-switch/)
    expect(log).not.toContain(' clear-run ')
    expect(world.commands).not.toContain('clear')
  })

  test('[W8 r2 low] in the bound run turn (BRIEFING) a failed kill-switch check reads as on: the run is cancelled', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on)
    await startSession($, world)
    await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'keep going', turnId: 't1' })
    await $.turn.complete(TURN)
    await clock.settle()
    await clock.advance(10)
    await $.prompt.submit({ text: RUN_PROMPT(`${OLD}#1`), wait: false, origin: { kind: 'plugin', name: 'context-handoff' } })
    await $.turn.start({ text: RUN_TURN_TEXT(`${OLD}#1`), turnId: 't2' })
    expect(logOf(world)).toContain(' auto-run-bound ')
    world.failing.add('kill-switch-check')
    await clock.advance(1_100)
    await clock.settle()
    const log = logOf(world)
    expect(log).toContain('reads it as on (before the clear)')
    expect(log).toMatch(/ cancelled .*kill-switch/)
  })

  test('[W8 r2] after the clear a failed kill-switch check reads as off: the seed fallback still fills the box', async ($, on) => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const wrapped = ((event: string, hook: (...args: any[]) => unknown) => (on as any)(event,
      event !== 'prompt.submit' ? hook : async ($: any, e: any, next: any) => {
        if (e.origin?.kind === 'plugin' && !e.text.startsWith('/context-handoff:compact-crafter automatic-run ')) await held
        return hook($, e, next)
      })) as typeof on
    const world = worldOf(wrapped, { dropPluginPrompts: true })
    const clock = mock.clock(on)
    await startSession($, world)
    await toClearing($, world, clock)
    await $.session.end({ reason: 'clear', sessionId: OLD })
    await $.classic.SessionStart({ source: 'clear', session_id: world.sessionId })
    await clock.advance(10)
    world.failing.add('kill-switch-check')
    await clock.advance(1_000)
    release()
    await clock.settle()
    expect(logOf(world)).toContain(' watchdog-failed ')
    expect(world.fills).toHaveLength(1)
    expect(world.statuses.some(s => s?.includes('disabled'))).toBe(false)
  })

  test('a prune whose rm fails is logged and the load goes on', async ($, on) => {
    const now = 40 * DAY
    const world = worldOf(on, { failing: new Set(['rm']) })
    const stale = `${STATE}/sessions/33333333-aaaa-4bbb-8ccc-000000000003.json`
    world.files.set(stale, '{}')
    world.mtimes.set(stale, 0)
    const clock = mock.clock(on, { now })
    await startSession($, world)
    await clock.settle()
    const log = logOf(world)
    expect(log).toContain(' sessions-prune-failed rm exit 1')
    expect(log).toContain(' loaded owner=')
  })
})
