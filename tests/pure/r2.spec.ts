import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import { appendArgv, formatLogLine } from '../../hooks/log'
import { initialState, step } from '../../hooks/machine'
import type { MachineEvent, MachineState } from '../../hooks/machine'
import { parsePid, resolveOwner } from '../../hooks/owner'
import { afterPersistFailure, findOwnClearing, loadMachine, persistState, sessionFile } from '../../hooks/store'
import type { StoreFs } from '../../hooks/store'
import { isTypedPrompt, originOf, TurnTracker } from '../../hooks/turns'
import { runToGrace } from './run-path'

const CONFIG = resolveConfig({}, {}).config
const OLD = '11111111-aaaa-4bbb-8ccc-000000000001'
const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
const OTHER = '33333333-aaaa-4bbb-8ccc-000000000003'
const T0 = 1_000_000
const DIR = fixturePath('state')

type TurnEnd = Extract<MachineEvent, { type: 'turnEnd' }>
const turnEnd = (over: Partial<TurnEnd> = {}): TurnEnd => ({
  type: 'turnEnd', now: T0, sessionId: OLD, turnId: 't1', reason: 'answer', percent: 75, tokens: 750_000,
  draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over,
})
const idle = (): MachineState => ({ ...initialState(OLD, T0, 'o'), transcriptPath: fixturePath('t.jsonl') })
const logsOf = (effects: Array<{ type: string; event?: string; detail?: string }>) => effects.filter(e => e.type === 'log').map(e => `${e.event} ${e.detail}`)

function memFs(files: Record<string, string> = {}): StoreFs & { files: Map<string, string> } {
  const map = new Map(Object.entries(files))
  return {
    files: map,
    exists: async p => map.has(p) || [...map.keys()].some(k => k.startsWith(`${p}/`)),
    read: async p => {
      const t = map.get(p)
      if (t === undefined) throw new Error(`ENOENT ${p}`)
      return t
    },
    write: async (p, t) => void map.set(p, t),
    list: async p => [...map.keys()].filter(k => k.startsWith(`${p}/`)).map(k => ({ name: k.slice(p.length + 1), kind: 'file' })),
  }
}

function clearingOf(sessionId: string, ownerId: string, enteredAt: number): MachineState {
  return { ...initialState(sessionId, enteredAt, ownerId), phase: 'CLEARING', cycleId: `${sessionId}#1`, deadline: enteredAt + 30_000, clearingFrom: sessionId, briefPath: fixturePath('b.md'), verifiedCycleId: `${sessionId}#1` }
}

describe('[medium M1] Stop re-prompt and prompt-less continuation cancel a running cycle', () => {
  // The Stop record and the block cancel are now separate events (record before the settings
  // Stop hooks, cancel after): tests/pure/r3-stop.spec.ts covers both, including the subagent case.

  // W2c port: BRIEFING is now the skill run, where a Stop block re-prompts the run and another turn
  // does not consume the arm (auto-run.spec pins both). GRACE keeps the old cancel, asserted here.
  test('the stop-blocked cancel aborts GRACE with that reason; in BRIEFING the run continues', () => {
    const b = step(idle(), turnEnd(), CONFIG).state
    const kept = step(b, { type: 'cancel', now: T0 + 1, reason: 'stop-blocked' }, CONFIG)
    expect(kept.state.phase).toBe('BRIEFING')
    expect(logsOf(kept.effects)[0]).toContain('auto-run-stop-blocked')
    const g = runToGrace(b, CONFIG, T0)
    expect(g.phase).toBe('GRACE')
    const r = step(g, { type: 'cancel', now: T0 + 20, reason: 'stop-blocked' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(logsOf(r.effects)[0]).toContain('stop-blocked')
  })

  test('a main turn end of another turn in GRACE cancels; in BRIEFING it is logged and the run stays', () => {
    const b = step(idle(), turnEnd(), CONFIG).state
    expect(b.phase).toBe('BRIEFING')
    const other = step(b, turnEnd({ turnId: 't2', now: T0 + 5 }), CONFIG)
    expect(other.state.phase).toBe('BRIEFING')
    expect(logsOf(other.effects)[0]).toContain('auto-run-other-turn')
    const g = runToGrace(b, CONFIG, T0)
    const r = step(g, turnEnd({ turnId: 't2', now: T0 + 20 }), CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(logsOf(r.effects)[0]).toContain('other-turn')
  })

  test('a repeated turn end of the same turn does not cancel', () => {
    const b = step(idle(), turnEnd(), CONFIG).state
    expect(step(b, turnEnd({ now: T0 + 5 }), CONFIG).state.phase).toBe('BRIEFING')
  })

  test('a prompt-less turn start is an other turn (not ignored), whatever runs', () => {
    const t = new TurnTracker()
    expect(t.onTurnStart('t9', '').origin).toBe('other')
  })
})

describe('[medium M2] owner stamp is per process', () => {
  test('mints <pid>:<uuid>', () => {
    expect(resolveOwner(undefined, 4242, 'u1')).toEqual({ ownerId: '4242:u1', isAdopted: false })
  })

  test('adopts an inherited owner only when its pid is this process', () => {
    expect(resolveOwner('4242:u0', 4242, 'u1')).toEqual({ ownerId: '4242:u0', isAdopted: true })
    expect(resolveOwner('1111:u0', 4242, 'u1')).toEqual({ ownerId: '4242:u1', isAdopted: false })
    expect(resolveOwner('u0-without-pid', 4242, 'u1')).toEqual({ ownerId: '4242:u1', isAdopted: false })
  })

  test('an unknown pid never adopts', () => {
    expect(resolveOwner('0:u0', null, 'u1')).toEqual({ ownerId: '0:u1', isAdopted: false })
  })

  test('parses the pid printed by sh', () => {
    expect(parsePid('4242\n')).toBe(4242)
    expect(parsePid('')).toBeNull()
    expect(parsePid('x')).toBeNull()
  })
})

describe('[medium M3] store: discovery, retirement, owner matching', () => {
  test('findOwnClearing picks the newest CLEARING of this owner and ignores others', async () => {
    const fs = memFs({
      [`${DIR}/sessions/${OLD}.json`]: JSON.stringify(clearingOf(OLD, 'me', T0)),
      [`${DIR}/sessions/${OTHER}.json`]: JSON.stringify(clearingOf(OTHER, 'someone', T0 + 100)),
      [`${DIR}/sessions/x.json`]: JSON.stringify({ ...clearingOf('44444444-aaaa-4bbb-8ccc-000000000004', 'me', T0 + 50), phase: 'GRACE' }),
      [`${DIR}/sessions/torn.json`]: '{',
    })
    expect((await findOwnClearing(fs, DIR, 'me'))?.sessionId).toBe(OLD)
    expect(await findOwnClearing(fs, DIR, 'nobody')).toBeNull()
    expect(await findOwnClearing(memFs(), DIR, 'me')).toBeNull()
  })

  test('loadMachine resumes this owner\'s CLEARING under the new id after a reload', async () => {
    const fs = memFs({ [`${DIR}/sessions/${OLD}.json`]: JSON.stringify(clearingOf(OLD, 'me', T0)) })
    const loaded = await loadMachine(fs, DIR, NEW, 'me', 'L2', T0 + 10)
    expect(loaded.state.phase).toBe('CARRYING')
    expect(loaded.state.sessionId).toBe(NEW)
    expect(loaded.persistedSessionId).toBe(OLD)
  })

  test('[low] every state loadMachine returns carries this load\'s owner and load id', async () => {
    const fs = memFs({ [`${DIR}/sessions/${NEW}.json`]: JSON.stringify(clearingOf(NEW, 'dead-owner', T0)) })
    const reset = await loadMachine(fs, DIR, NEW, 'me', 'L2', T0 + 10)
    expect(reset.state.phase).toBe('IDLE')
    expect(reset.state.ownerId).toBe('me')
    expect(reset.state.loadId).toBe('L2')
    const fresh = await loadMachine(memFs(), DIR, NEW, 'me', 'L3', T0)
    expect([fresh.state.ownerId, fresh.state.loadId]).toEqual(['me', 'L3'])
    const idleFile = memFs({ [`${DIR}/sessions/${NEW}.json`]: JSON.stringify({ ...initialState(NEW, T0, 'old'), loadId: 'L1' }) })
    const kept = await loadMachine(idleFile, DIR, NEW, 'me', 'L4', T0)
    expect([kept.state.ownerId, kept.state.loadId]).toEqual(['me', 'L4'])
  })

  test('persistState retires the session left behind as IDLE', async () => {
    const fs = memFs()
    const state = { ...clearingOf(NEW, 'me', T0), phase: 'CARRYING' as const, loadId: 'L1' }
    expect(await persistState(fs, DIR, state, OLD, 'L1')).toBe('written')
    const retired = JSON.parse(fs.files.get(`${DIR}/sessions/${OLD}.json`) as string)
    expect([retired.phase, retired.sessionId, retired.deadline, retired.cycleId]).toEqual(['IDLE', OLD, null, null])
    expect(JSON.parse(fs.files.get(`${DIR}/sessions/${NEW}.json`) as string).phase).toBe('CARRYING')
  })

  test('[low] a write from a superseded load is refused (per-load id)', async () => {
    const L1 = `${T0}-l1`
    const L2 = `${T0 + 1}-l2`
    const fs = memFs({ [`${DIR}/sessions/${OLD}.json`]: JSON.stringify({ ...initialState(OLD, T0, 'me'), loadId: L2 }) })
    const stale = { ...initialState(OLD, T0, 'me'), phase: 'BRIEFING' as const, loadId: L1 }
    expect(await persistState(fs, DIR, stale, OLD, L1)).toBe('superseded')
    expect(JSON.parse(fs.files.get(`${DIR}/sessions/${OLD}.json`) as string).phase).toBe('IDLE')
    expect(await persistState(fs, DIR, { ...stale, loadId: L2 }, OLD, L2)).toBe('written')
  })

  test('sessionFile refuses an id that could escape the folder', () => {
    expect(sessionFile(DIR, '../x')).toBeNull()
    expect(sessionFile(DIR, OLD)).toBe(`${DIR}/sessions/${OLD}.json`)
  })

  test('[low] a persist failure aborts before GRACE and lets later phases continue', () => {
    expect(['BRIEFING', 'GRACE'].map(p => afterPersistFailure(p as never))).toEqual(['abort', 'abort'])
    expect(['IDLE', 'CLEARING', 'CARRYING', 'SEEDING'].map(p => afterPersistFailure(p as never))).toEqual(['continue', 'continue', 'continue', 'continue'])
  })
})

describe('[low] log appends one line per write', () => {
  test('a line is ISO time first, one line, capped', () => {
    const line = formatLogLine('2026-10-05T00:00:00.000Z', OLD, 'grace', 'a\nb   c')
    expect(line).toBe('2026-10-05T00:00:00.000Z 11111111 grace a b c')
    expect(formatLogLine('t', OLD, 'e', 'x'.repeat(10_000)).length).toBeLessThanOrEqual(4_000)
  })

  test('the append is an O_APPEND shell redirect with the line and path as arguments, never in the script', () => {
    const argv = appendArgv(fixturePath('state/handoff.log'), 'line with $(danger) and "quotes"')
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(argv[2]).toContain('>> "$2"')
    expect(argv[2]).not.toContain('danger')
    expect(argv.slice(3)).toEqual(['sh', 'line with $(danger) and "quotes"', fixturePath('state/handoff.log')])
  })
})

describe('[low] turn binding', () => {
  test('a bridge prompt is typed for the cycle; handoff_now origin stays composer-only', () => {
    expect(isTypedPrompt({ kind: 'bridge' })).toBe(true)
    expect(isTypedPrompt({ kind: 'composer' })).toBe(true)
    expect(isTypedPrompt({ kind: 'plugin', name: 'x' })).toBe(false)
    expect(originOf({ kind: 'bridge' }, 'context-handoff')).toBe('other')
    expect(originOf({ kind: 'plugin', name: 'context-handoff' }, 'context-handoff')).toBe('own-seed')
  })

  test('a typed prompt that never starts a turn does not leak into the next prompt-less turn', () => {
    const t = new TurnTracker()
    t.onPromptSubmit('composer', '/compact-crafter', undefined)
    t.onTurnComplete('t0')
    expect(t.onTurnStart('t1', '')).toEqual({ turnId: 't1', origin: 'other', promptText: '', turnText: '', isPrompted: false })
  })

  test('a typed prompt binds to the turn it starts; the turn info clears at that turn\'s end', () => {
    const t = new TurnTracker()
    t.onPromptSubmit('composer', 'please compact', undefined)
    expect(t.onTurnStart('t1', 'please compact')).toEqual({ turnId: 't1', origin: 'composer', promptText: 'please compact', turnText: 'please compact', isPrompted: true })
    expect(t.current?.turnId).toBe('t1')
    t.onTurnComplete('t1')
    expect(t.current).toBeNull()
  })

  test('a prompt typed over a running turn does not become the pending origin', () => {
    const t = new TurnTracker()
    t.onPromptSubmit('composer', 'compact', 't-running')
    expect(t.onTurnStart('t2', '').origin).toBe('other')
  })
})

describe('[low] session.end clear after the carry is not a drop', () => {
  test('reason clear in CARRYING or SEEDING keeps the cycle', () => {
    let s = step(idle(), turnEnd(), CONFIG).state
    const id = s.cycleId as string
    s = runToGrace(s, CONFIG, T0, fixturePath('b.md'))
    s = step(s, { type: 'tick', now: s.deadline as number, isKillSwitchOn: false }, CONFIG).state
    s = step(s, { type: 'sessionStart', now: s.enteredAt + 1, sessionId: NEW, source: 'clear' }, CONFIG).state
    expect(s.phase).toBe('CARRYING')
    expect(step(s, { type: 'sessionEnd', now: s.enteredAt + 2, reason: 'clear' }, CONFIG).state.phase).toBe('CARRYING')
    const seeding = step(s, { type: 'carryDone', cycleId: id, now: s.enteredAt + 3 }, CONFIG).state
    expect(step(seeding, { type: 'sessionEnd', now: seeding.enteredAt + 1, reason: 'clear' }, CONFIG).state.phase).toBe('SEEDING')
  })
})
