import { fixturePath } from '../fixtures/paths'

// The newer-load guard reads, then writes. A newer load
// that writes right after is caught by a read after the write: the older load reports superseded.
import { describe, expect, test } from 'bun:test'

import { initialState } from '../../hooks/machine'
import { persistState } from '../../hooks/store'
import type { StoreFs } from '../../hooks/store'
import { serializeState } from '../../hooks/state-file'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const DIR = fixturePath('state')
const FILE = `${DIR}/sessions/${SID}.json`
const T0 = 1_000_000
const OLDER = `${T0}-aaaaaaaa`
const NEWER = `${T0 + 5}-bbbbbbbb`

function memFs(afterWrite: (fs: { files: Map<string, string> }, path: string) => void = () => {}): StoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  const fs = {
    files,
    exists: async (p: string) => files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
    read: async (p: string) => {
      const text = files.get(p)
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return text
    },
    write: async (p: string, t: string) => {
      files.set(p, t)
      afterWrite(fs, p)
    },
    list: async (p: string) => [...files.keys()].filter(k => k.startsWith(`${p}/`)).map(k => ({ name: k.slice(p.length + 1), kind: 'file' })),
  }
  return fs
}

describe('[D] a newer load that writes between the check and the write is noticed', () => {
  test('the older load reports superseded when the file holds a newer load after its write', async () => {
    // The newer load's write lands right after the older load's write, before its re-read.
    const fs = memFs((f, p) => {
      if (p === FILE && !f.files.get(p)?.includes(NEWER)) f.files.set(p, serializeState({ ...initialState(SID, T0, 'me'), loadId: NEWER }))
    })
    expect(await persistState(fs, DIR, { ...initialState(SID, T0, 'me'), loadId: OLDER }, SID, OLDER)).toBe('superseded')
  })

  test('a write that nobody races is still written', async () => {
    const fs = memFs()
    expect(await persistState(fs, DIR, { ...initialState(SID, T0, 'me'), loadId: OLDER }, SID, OLDER)).toBe('written')
    expect(fs.files.get(FILE)).toContain(OLDER)
  })
})

describe('[D r1] a read-back that rejects does not undo a good write', () => {
  test('exists rejecting after the write: written, and the failure is reported', async () => {
    const fs = memFs()
    const reports: string[] = []
    let writes = 0
    const shaky: StoreFs = {
      ...fs,
      write: async (p, t) => { writes += 1; await fs.write(p, t) },
      exists: async p => { if (writes > 0) throw new Error(`EPERM exists ${p}`); return fs.exists(p) },
      report: (event, detail) => void reports.push(`${event} ${detail}`),
    }
    expect(await persistState(shaky, DIR, { ...initialState(SID, T0, 'me'), loadId: OLDER }, SID, OLDER)).toBe('written')
    expect(fs.files.get(FILE)).toContain(OLDER)
    expect(reports.join('\n')).toContain('state-read-failed read-back')
  })
})
