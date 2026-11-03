import { fixturePath } from '../fixtures/paths'

// W2d fixes 3-7: hot-reload window, --dir only the brief folder, Read limited, the per-session
// loop bound of automatic runs that never clear, and owner isolation. Namespace imports so a
// missing export fails its own test, not the file.
import { describe, expect, test } from 'bun:test'

import * as allowlist from '../../hooks/allowlist'
import type { RunContext } from '../../hooks/allowlist'
import { resolveConfig } from '../../hooks/config'
import type { HandoffConfig } from '../../hooks/config'
import * as guards from '../../hooks/guards'
import * as machine from '../../hooks/machine'
import type { Effect, MachineEvent, MachineState } from '../../hooks/machine'
import { parseState, serializeState } from '../../hooks/state-file'
import { loadMachine } from '../../hooks/store'
import type { StoreFs } from '../../hooks/store'

const { initialState, step, recoverAfterReload } = machine
const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
const T0 = 1_000_000
const CYCLE = `${SID}#1`
const CONFIG: HandoffConfig = { ...resolveConfig({}, {}).config, thresholdTokens: 5_000 }
const HOME = fixturePath('Users/me')
const BRIEF = `${HOME}/.claude/state/compact-handoffs`
const REPO = fixturePath('repo')
const TRANSCRIPT = `${HOME}/.claude/projects/-proj/${SID}.jsonl`
const CTX = { handoffTool: 'mcp__context-handoff__handoff_now', repoRoot: REPO, home: HOME, briefDir: BRIEF, sessionId: SID, transcriptPath: TRANSCRIPT } as RunContext
const allowed = (tool: string, input: Record<string, unknown>) => 'allow' in allowlist.allowInRun({ tool, input }, CTX)
const logs = (effects: Effect[]) => effects.flatMap(e => (e.type === 'log' ? [`${e.event} ${e.detail}`] : []))

function run(state: MachineState, events: MachineEvent[]) {
  let current = state
  const effects: Effect[] = []
  for (const e of events) {
    const s = step(current, e, CONFIG)
    current = s.state
    effects.push(...s.effects)
  }
  return { state: current, effects }
}
const turnEnd = (over: Partial<Extract<MachineEvent, { type: 'turnEnd' }>> = {}): MachineEvent =>
  ({ type: 'turnEnd', now: T0, sessionId: SID, turnId: 't1', reason: 'answer', percent: 12, tokens: 120_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'a', ...over })
const idle = (over: Partial<MachineState> = {}): MachineState => ({ ...initialState(SID, T0, 'owner-a'), transcriptPath: fixturePath('t.jsonl'), ...over })
const armed = (s = idle()) => run(s, [turnEnd()]).state
const called = (s = idle()) => run(armed(s), [{ type: 'autoRunCalled', cycleId: s.sessionId === SID ? `${SID}#${s.cycleSeq + 1}` : '', now: T0 + 20 }]).state
const markup = `<command-message>context-handoff:compact-crafter</command-message>\n<command-args>automatic-run cycle=${CYCLE} session=${SID}</command-args>`
const bound = () => run(called(), [
  { type: 'autoRunSubmit', cycleId: CYCLE, now: T0 + 30 },
  { type: 'turnStart', now: T0 + 40, origin: 'own-skill', turnId: 'run1', text: markup, isPrompted: true },
]).state

describe('fix 3: hot reload keeps the window', () => {
  test('the bound run turn ids survive the state file', () => {
    expect(parseState(serializeState(bound()))?.autoRun?.turnIds).toEqual(['run1'])
  })

  test('reloadWindowOf: BRIEFING with bound ids -> those ids; called but unbound -> [] (unknown turn); IDLE -> null', () => {
    expect(machine.reloadWindowOf?.(bound())).toEqual(['run1'])
    expect(machine.reloadWindowOf?.(called())).toEqual([])
    expect(machine.reloadWindowOf?.(idle())).toBeNull()
  })

  test('loadMachine returns the window of a persisted BRIEFING run (and still resets it to IDLE)', async () => {
    const fs = memFs()
    fs.files.set(fixturePath(`state/sessions/${SID}.json`), serializeState(bound()))
    const loaded = await loadMachine(fs, fixturePath('state'), SID, 'owner-a', `${T0}-x`, T0 + 50)
    expect(loaded.state.phase).toBe('IDLE')
    expect((loaded as { reloadWindow?: unknown }).reloadWindow).toEqual(['run1'])
  })

  test('isInRunWindow: bound turn; after a reload the in-flight turn (no current) and, with unknown ids, any turn', () => {
    const w = allowlist.isInRunWindow
    expect(typeof w).toBe('function')
    expect(w('run1', new Set(['run1']), null)).toBe(true)
    expect(w('x', new Set(['run1']), null)).toBe(false)
    expect(w(null, new Set(), null)).toBe(false)
    expect(w(null, new Set(), ['run1'])).toBe(true)
    expect(w('run1', new Set(), ['run1'])).toBe(true)
    expect(w('later', new Set(), ['run1'])).toBe(false)
    expect(w('later', new Set(), [])).toBe(true)
    expect(w(null, new Set(), [])).toBe(true)
  })
})

describe('fix 4: snapshot-path.py --dir only the brief folder', () => {
  const cmd = (dir: string) => `python3 ${REPO}/skills/compact-crafter/scripts/snapshot-path.py --session ${SID} --dir ${dir}`
  test('omitted, the brief folder (bare or quoted) pass', () => {
    expect(allowed('Bash', { command: `python3 ${REPO}/skills/compact-crafter/scripts/snapshot-path.py --session ${SID}` })).toBe(true)
    expect(allowed('Bash', { command: cmd(BRIEF) })).toBe(true)
    expect(allowed('Bash', { command: cmd(`"${BRIEF}"`) })).toBe(true)
  })
  test('any other folder is denied', () => {
    for (const dir of [fixturePath('tmp/x'), `${HOME}/.claude/hooks`, `${BRIEF}/sub`, `${BRIEF}/..`, '~/.claude', `${BRIEF}x`]) {
      expect([dir, allowed('Bash', { command: cmd(dir) })]).toEqual([dir, false])
    }
  })
})

describe('fix 5: Read only the brief folder, the skill folders and the transcript', () => {
  test('allowed paths', () => {
    for (const p of [`${BRIEF}/${SID}-x.md`, `${REPO}/skills/compact-crafter/reference/snapshot-template.md`, `${REPO}/skills/compact-crafter/SKILL.md`, TRANSCRIPT, `${HOME}/.claude/projects/-proj/${SID}/subagents/agent-1.jsonl`]) {
      expect([p, allowed('Read', { file_path: p })]).toEqual([p, true])
    }
  })
  test('everything else is denied', () => {
    for (const p of [fixturePath('etc/passwd'), `${HOME}/.ssh/id_rsa`, `${HOME}/.claude/settings.json`, `${BRIEF}/../x`, `${BRIEF}`, `${REPO}/skills/compact-crafter/../other/x`, `${HOME}/.claude/projects/-proj/other.jsonl`, `${TRANSCRIPT}.bak`, `${HOME}/.claude/skills/compact-crafter/SKILL.md`, `${HOME}/.claude/skills/compact-crafter-evil/x`, 3]) {
      expect([p, allowed('Read', { file_path: p })]).toEqual([p, false])
    }
  })
  test('with no transcript known, the transcript form is denied', () => {
    expect('allow' in allowlist.allowInRun({ tool: 'Read', input: { file_path: TRANSCRIPT } }, { ...CTX, transcriptPath: null } as RunContext)).toBe(false)
  })
})

describe('fix 6: per-session bound on automatic runs that end without a clear', () => {
  const cap = () => (guards as { UNCLEARED_RUN_CAP?: number }).UNCLEARED_RUN_CAP
  const uncleared = (s: MachineState) => (s as { unclearedRuns?: number }).unclearedRuns
  test('the cap is 3', () => expect(cap()).toBe(3))

  test('a typed-prompt cancel of a called run is charged; an arm cancelled before auto-run-called is not', () => {
    expect(uncleared(run(called(), [{ type: 'typedPrompt', now: T0 + 50 }]).state)).toBe(1)
    expect(uncleared(run(armed(), [{ type: 'typedPrompt', now: T0 + 50 }]).state)).toBe(0)
  })

  test('a failure (timeout) is charged too', () => {
    expect(uncleared(run(called(), [{ type: 'tick', now: T0 + 10_000_000, isKillSwitchOn: false }]).state)).toBe(1)
  })

  test('the third uncleared run pins a notice naming handoff.log; then the automatic path is off', () => {
    const third = run(called(idle({ unclearedRuns: 2 } as Partial<MachineState>)), [{ type: 'typedPrompt', now: T0 + 50 }])
    expect(uncleared(third.state)).toBe(3)
    const notices = third.effects.flatMap(e => (e.type === 'pinNotice' ? [e.text] : []))
    expect(notices.some(t => t.includes('handoff.log'))).toBe(true)
    const next = run({ ...third.state, backoffTokens: null, backoffKind: null }, [turnEnd({ turnId: 't9', now: T0 + 100 })])
    expect(next.state.phase).toBe('IDLE')
    expect(logs(next.effects).some(l => l.startsWith('guard-skip uncleared-run-cap'))).toBe(true)
  })

  test('the manual path is never charged', () => {
    const manualGrace = idle({ phase: 'GRACE', isManual: true, cycleId: CYCLE, cycleSeq: 1, briefPath: fixturePath('b.md'), deadline: T0 + 99_000, unclearedRuns: 2 } as Partial<MachineState>)
    expect(uncleared(run(manualGrace, [{ type: 'typedPrompt', now: T0 + 50 }]).state)).toBe(2)
  })

  test('reset on session change and at carry', () => {
    expect(uncleared(run(idle({ unclearedRuns: 3 } as Partial<MachineState>), [{ type: 'sessionStart', now: T0 + 5, sessionId: NEW, source: 'resume' }]).state)).toBe(0)
    const clearing = idle({ phase: 'CLEARING', cycleId: CYCLE, cycleSeq: 1, clearingFrom: SID, briefPath: fixturePath('b.md'), deadline: T0 + 99_000, unclearedRuns: 2 } as Partial<MachineState>)
    const carried = recoverAfterReload(clearing, NEW, 'owner-a', T0 + 10)
    expect(carried.state.phase).toBe('CARRYING')
    expect(uncleared(carried.state)).toBe(0)
  })

  test('an older state file without the field reads as 0', () => {
    const raw = JSON.parse(serializeState(idle()))
    delete raw.unclearedRuns
    expect(uncleared(parseState(JSON.stringify(raw)) as MachineState)).toBe(0)
  })
})

describe('fix 7: isolation', () => {
  test('two owners, two CLEARING files: each load adopts only its own', async () => {
    const fs = memFs()
    const A = '33333333-aaaa-4bbb-8ccc-00000000000a'
    const B = '44444444-aaaa-4bbb-8ccc-00000000000b'
    const clearing = (id: string, owner: string) => serializeState({ ...initialState(id, T0, owner), phase: 'CLEARING', cycleId: `${id}#1`, cycleSeq: 1, clearingFrom: id, briefPath: fixturePath(`b/${id}.md`), deadline: T0 + 99_000 })
    fs.files.set(fixturePath(`state/sessions/${A}.json`), clearing(A, 'owner-a'))
    fs.files.set(fixturePath(`state/sessions/${B}.json`), clearing(B, 'owner-b'))
    const la = await loadMachine(fs, fixturePath('state'), 'new-a', 'owner-a', `${T0 + 1}-a`, T0 + 10)
    const lb = await loadMachine(fs, fixturePath('state'), 'new-b', 'owner-b', `${T0 + 1}-b`, T0 + 10)
    expect([la.persistedSessionId, la.state.phase, la.state.briefPath]).toEqual([A, 'CARRYING', fixturePath(`b/${A}.md`)])
    expect([lb.persistedSessionId, lb.state.phase, lb.state.briefPath]).toEqual([B, 'CARRYING', fixturePath(`b/${B}.md`)])
  })
})

function memFs(): StoreFs & { files: Map<string, string> } {
  const map = new Map<string, string>()
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
