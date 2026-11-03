import { fixturePath } from '../fixtures/paths'

// A read error and a corrupt file must stay distinct from an absent file, so an
// older load cannot overwrite a newer load's file after a transient read error. Both failures are
// reported (`state-read-failed <kind>`); a corrupt file is still replaced, a read error refuses the
// write, and persistState rejects so the existing persist-failure path runs.
import { describe, expect, test } from 'bun:test'

import { initialState } from '../../hooks/machine'
import { loadMachine, persistState } from '../../hooks/store'
import type { StoreFs } from '../../hooks/store'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const DIR = fixturePath('state')
const FILE = `${DIR}/sessions/${SID}.json`
const T0 = 1_000_000
const L1 = `${T0}-aaaaaaaa`

function memFs(readFails = false): StoreFs & { files: Map<string, string>; reports: string[] } {
  const files = new Map<string, string>()
  const reports: string[] = []
  return {
    files, reports,
    exists: async p => files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
    read: async p => {
      if (readFails) throw new Error(`EIO: i/o error, read '${p}'`)
      const text = files.get(p)
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return text
    },
    write: async (p, t) => void files.set(p, t),
    list: async p => [...files.keys()].filter(k => k.startsWith(`${p}/`)).map(k => ({ name: k.slice(p.length + 1), kind: 'file' })),
    report: (event, detail) => void reports.push(`${event} ${detail}`),
  }
}

describe('[C] a state file that cannot be read is not the same as no file', () => {
  test('a corrupt file is reported and replaced, as before', async () => {
    const fs = memFs()
    fs.files.set(FILE, '{not json')
    expect(await persistState(fs, DIR, { ...initialState(SID, T0, 'me'), loadId: L1 }, SID, L1)).toBe('written')
    expect(JSON.parse(fs.files.get(FILE) as string).loadId).toBe(L1)
    expect(fs.reports.some(r => r.startsWith(`state-read-failed parse ${FILE}`))).toBe(true)
  })

  test('a read error refuses the overwrite: persistState rejects and the file is untouched', async () => {
    const fs = memFs(true)
    fs.files.set(FILE, '{"kept": true}')
    const state = { ...initialState(SID, T0, 'me'), loadId: L1 }
    await expect(persistState(fs, DIR, state, SID, L1)).rejects.toThrow('state-read-failed io')
    expect(fs.files.get(FILE)).toBe('{"kept": true}')
    expect(fs.reports.some(r => r.startsWith(`state-read-failed io ${FILE}: Error: EIO`))).toBe(true)
  })

  test('a load that cannot read its file is reported and starts fresh, as before', async () => {
    const fs = memFs(true)
    fs.files.set(FILE, '{"kept": true}')
    const loaded = await loadMachine(fs, DIR, SID, 'me', L1, T0)
    expect(loaded.state.phase).toBe('IDLE')
    expect(fs.reports.some(r => r.startsWith(`state-read-failed io ${FILE}`))).toBe(true)
  })
})

describe('[C r1] a file removed between the existence check and the read is absent, not a read error', () => {
  test('ENOENT from the read: the write goes ahead and nothing is reported', async () => {
    const fs = memFs()
    fs.exists = async () => true
    const state = { ...initialState(SID, T0, 'me'), loadId: L1 }
    expect(await persistState(fs, DIR, state, SID, L1)).toBe('written')
    expect(fs.reports).toEqual([])
  })
})

describe('[C r2] the path is cut out before ENOENT is read', () => {
  test('an EIO on a state file whose path contains ENOENT stays a read error', async () => {
    const odd = fixturePath('state-ENOENT')
    const path = `${odd}/sessions/${SID}.json`
    const fs = memFs()
    fs.files.set(path, '{"kept": true}')
    fs.read = async p => { throw new Error(`EIO: i/o error, read '${p}'`) }
    await expect(persistState(fs, odd, { ...initialState(SID, T0, 'me'), loadId: L1 }, SID, L1)).rejects.toThrow('state-read-failed io')
    expect(fs.files.get(path)).toBe('{"kept": true}')
  })
})
