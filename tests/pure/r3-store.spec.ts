import { fixturePath } from '../fixtures/paths'

// The per-load write guard must refuse only an OLDER load, never the newer load
// that just reloaded the module.
import { describe, expect, test } from 'bun:test'

import { initialState } from '../../hooks/machine'
import type { MachineState } from '../../hooks/machine'
import { loadMachine, persistState } from '../../hooks/store'
import type { StoreFs } from '../../hooks/store'

const OLD = '11111111-aaaa-4bbb-8ccc-000000000001'
const NEW = '22222222-aaaa-4bbb-8ccc-000000000002'
const DIR = fixturePath('state')
const T0 = 1_000_000
const L1 = `${T0}-aaaaaaaa`
const L2 = `${T0 + 5_000}-bbbbbbbb`
const L3 = `${T0 + 9_000}-cccccccc`

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

const fileOf = (fs: { files: Map<string, string> }, id: string): MachineState =>
  JSON.parse(fs.files.get(`${DIR}/sessions/${id}.json`) as string)

describe('[high] a newer load claims the files an older load wrote', () => {
  test('L1 writes, L2 loads and persists (written), then an L1 write is superseded', async () => {
    const fs = memFs()
    expect(await persistState(fs, DIR, { ...initialState(OLD, T0, 'me'), loadId: L1 }, OLD, L1)).toBe('written')

    const loaded = await loadMachine(fs, DIR, OLD, 'me', L2, T0 + 5_000)
    expect(await persistState(fs, DIR, loaded.state, loaded.persistedSessionId, L2)).toBe('written')
    expect(fileOf(fs, OLD).loadId).toBe(L2)

    const stale = { ...initialState(OLD, T0, 'me'), phase: 'BRIEFING' as const, loadId: L1 }
    expect(await persistState(fs, DIR, stale, OLD, L1)).toBe('superseded')
    expect(fileOf(fs, OLD).phase).toBe('IDLE')
  })

  test('reload mid-handoff: L1 persists CLEARING under OLD; L3 under NEW recovers CARRYING and its persist is written', async () => {
    const fs = memFs()
    const clearing: MachineState = {
      ...initialState(OLD, T0, 'me'), phase: 'CLEARING', cycleId: `${OLD}#1`, deadline: T0 + 30_000,
      clearingFrom: OLD, briefPath: fixturePath('b.md'), verifiedCycleId: `${OLD}#1`, loadId: L1,
    }
    expect(await persistState(fs, DIR, clearing, OLD, L1)).toBe('written')

    const loaded = await loadMachine(fs, DIR, NEW, 'me', L3, T0 + 9_000)
    expect(loaded.state.phase).toBe('CARRYING')
    expect(loaded.effects.some(e => e.type === 'carryMarkers')).toBe(true)
    expect(await persistState(fs, DIR, loaded.state, loaded.persistedSessionId, L3)).toBe('written')
    expect(fileOf(fs, NEW).phase).toBe('CARRYING')
    expect(fileOf(fs, OLD).phase).toBe('IDLE')
  })

  test('a file written by a load id without a stamp (older format) never blocks a new load', async () => {
    const fs = memFs()
    fs.files.set(`${DIR}/sessions/${OLD}.json`, JSON.stringify({ ...initialState(OLD, T0, 'me'), loadId: 'd3b07384-d9a0-4c9b-8f1e-000000000000' }))
    const loaded = await loadMachine(fs, DIR, OLD, 'me', L2, T0 + 5_000)
    expect(await persistState(fs, DIR, loaded.state, loaded.persistedSessionId, L2)).toBe('written')
  })
})
