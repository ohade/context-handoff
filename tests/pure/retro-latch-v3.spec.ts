import { fixturePath } from '../fixtures/paths'

// Retro latch coverage: the latch a handoff carries (E1), the
// lineage as store.ts persistState really writes it, and the late-clear path (E4).
import { describe, expect, test } from 'bun:test'

import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import { initialState, step } from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState, MarkerSnapshot } from '../../hooks/machine'
import { retroCarriedPath, retroCarryArgv, retroLatchSource } from '../../hooks/retro-latch'
import { persistState } from '../../hooks/store'
import type { StoreFs } from '../../hooks/store'
import { runToGrace } from './run-path'

const P = '11111111-aaaa-4bbb-8ccc-000000000001'
const N = '22222222-aaaa-4bbb-8ccc-000000000002'
const M = '33333333-aaaa-4bbb-8ccc-000000000003'
const HOME = fixturePath('Users/someone')
const STATE_DIR = fixturePath('state')
const OWNER = 'owner-a'
const T0 = 1_000_000
const BRIEF = fixturePath('tmp/briefs/x.md')
const CONFIG: HandoffConfig = resolveConfig({}, {}).config
const NONE = { active: false, approved: false, carried: false }
const LATCHED = { active: true, approved: false, carried: false }
const NO_LATCH = { active: false, approved: false }

const types = (effects: Effect[]) => effects.map(e => e.type)

/** The real persistState over an in-memory folder. */
function memoryFs(): StoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    exists: async path => files.has(path),
    read: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      files.set(path, text)
    },
    list: async () => [],
  }
}

function previousOf(fs: { files: Map<string, string> }, sessionId: string): unknown {
  return JSON.parse(fs.files.get(`${STATE_DIR}/sessions/${sessionId}.json`) as string).previousSessionId
}

/** CLEARING of session P, its brief queued with these markers. */
function clearing(markers: MarkerSnapshot): MachineState {
  const idle: MachineState = { ...initialState(P, T0, OWNER), transcriptPath: fixturePath('tmp/t.jsonl') }
  const turnEnd: MachineEvent = {
    type: 'turnEnd', now: T0, sessionId: P, reason: 'answer', percent: 75, tokens: 750_000,
    draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'final answer',
  }
  const grace = runToGrace(step(idle, turnEnd, CONFIG).state, CONFIG, T0, BRIEF, markers)
  return step(grace, { type: 'tick', now: grace.deadline as number, isKillSwitchOn: false }, CONFIG).state
}

const RETRO = { active: true, approved: false, sourceId: P }
const LATCHED_MARKERS: MarkerSnapshot = { project: null, verified: null, retro: RETRO }
const CARRY = { type: 'carryRetroLatch', fromSessionId: P, toSessionId: N, retro: RETRO, briefPath: BRIEF }

describe('TRACK-23 v3 E1: the latch a handoff carries', () => {
  test("this session's own latch comes first, approved or not", () => {
    expect(retroLatchSource(N, LATCHED, P, LATCHED)).toEqual({ active: true, approved: false, sourceId: N })
    expect(retroLatchSource(N, { ...LATCHED, approved: true }, P, LATCHED)).toEqual({ active: true, approved: true, sourceId: N })
  })

  test("else the previous session's latch, when it is active, unapproved and was never carried", () => {
    expect(retroLatchSource(N, NONE, P, LATCHED)).toEqual({ active: true, approved: false, sourceId: P })
    expect(retroLatchSource(N, NONE, P, { ...LATCHED, approved: true })).toEqual(NO_LATCH)
    expect(retroLatchSource(N, NONE, P, { ...LATCHED, carried: true })).toEqual(NO_LATCH)
    expect(retroLatchSource(N, NONE, P, NONE)).toEqual(NO_LATCH)
    expect(retroLatchSource(N, NONE, null, null)).toEqual(NO_LATCH)
  })

  test('carried-<id> sits beside the latch, keyed by a safe session id', () => {
    expect(retroCarriedPath(HOME, P)).toBe(`${HOME}/.claude/state/retro/carried-${P}`)
    expect(retroCarriedPath(HOME, '../x')).toBeNull()
  })

  test('P -> N with a failed carry, then N -> M: the files persistState writes are one hop deep, so N carries P to M', async () => {
    const fs = memoryFs()
    const atN: MachineState = { ...initialState(P, T0, OWNER), sessionId: N, previousSessionId: P }
    expect(await persistState(fs, STATE_DIR, atN, P, `${T0}-load`)).toBe('written')
    // N queues its handoff: no latch of its own, P's is active, unapproved and not carried.
    const source = retroLatchSource(N, NONE, atN.previousSessionId, LATCHED)
    const atM: MachineState = { ...atN, sessionId: M, previousSessionId: N }
    expect(await persistState(fs, STATE_DIR, atM, N, `${T0}-load`)).toBe('written')
    expect([previousOf(fs, P), previousOf(fs, N), previousOf(fs, M)]).toEqual([P, N, N])
    expect(source).toEqual({ active: true, approved: false, sourceId: P })
    expect(retroCarryArgv(HOME, source.sourceId ?? N, M)).toEqual(['env', `RETRO_STATE_DIR=${HOME}/.claude/state/retro`, 'bash', `${HOME}/.claude/skills/retro/scripts/retro-gate.sh`, 'carry', P, M])
  })
})

describe('TRACK-23 v3 E4: a late clear keeps the latch', () => {
  test('CLEARING with an unapproved latch, then sessionStart(clear) after the deadline: a carry, no fillSeed', () => {
    const s = clearing(LATCHED_MARKERS)
    const r = step(s, { type: 'sessionStart', now: (s.deadline as number) + 1_000, sessionId: N, source: 'clear' }, CONFIG)
    expect(r.state.phase).toBe('IDLE')
    expect(types(r.effects)).not.toContain('fillSeed')
    expect(r.effects).toContainEqual(CARRY)
  })

  test('without a latch the late clear still fills the seed and carries nothing', () => {
    const s = clearing({ project: null, verified: null })
    const r = step(s, { type: 'sessionStart', now: (s.deadline as number) + 1_000, sessionId: N, source: 'clear' }, CONFIG)
    expect(types(r.effects)).toContain('fillSeed')
    expect(types(r.effects)).not.toContain('carryRetroLatch')
  })

  test('a late clear after new-id-missing or clear-rejected also carries instead of filling', () => {
    const s = clearing(LATCHED_MARKERS)
    const cycleId = s.cycleId as string
    const missing = step(s, { type: 'newIdResolved', cycleId, now: s.enteredAt + 6_000, sessionId: null }, CONFIG).state
    const rejected = step(s, { type: 'clearResult', cycleId, now: s.enteredAt + 1_000, failure: 'refused' }, CONFIG).state
    for (const ended of [missing, rejected]) {
      expect(ended.phase).toBe('IDLE')
      const r = step(ended, { type: 'sessionStart', now: ended.enteredAt + 60_000, sessionId: N, source: 'clear' }, CONFIG)
      expect(types(r.effects)).not.toContain('fillSeed')
      expect(r.effects).toContainEqual(CARRY)
    }
  })
})
