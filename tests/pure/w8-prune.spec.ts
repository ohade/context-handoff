// Session files are scanned at load; prune stale entries while keeping current and recent ones.
import { describe, expect, test } from 'bun:test'

import { SESSION_FILE_MAX_AGE_MS, SESSION_PRUNE_LIMIT, staleSessionFiles } from '../../hooks/store'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const DAY = 86_400_000

describe('[E] old session files are pruned at load', () => {
  const now = 100 * DAY
  const entry = (name: string, ageDays: number, kind = 'file') => ({ name, kind, mtimeMs: now - ageDays * DAY })

  test('files untouched for more than 30 days are stale; newer ones and the own file are kept', () => {
    const entries = [
      entry('a.json', 31), entry('b.json', 29), entry(`${SID}.json`, 90), entry('c.json', 365),
      entry('notes.txt', 90), entry('d.json', 90, 'dir'),
    ]
    expect(staleSessionFiles(entries, now, `${SID}.json`).sort()).toEqual(['a.json', 'c.json'])
  })

  test('the age limit is 30 days, and an entry without a time is kept', () => {
    expect(SESSION_FILE_MAX_AGE_MS).toBe(30 * DAY)
    expect(staleSessionFiles([{ name: 'x.json', kind: 'file' }], now, 'own.json')).toEqual([])
    expect(staleSessionFiles([entry('y.json', 30)], now, 'own.json')).toEqual([])
  })
})

describe('[E r1] at most 500 files per load', () => {
  test('600 stale files give 500 names; the limit is 500', () => {
    const now = 100 * DAY
    const entries = Array.from({ length: 600 }, (_, i) => ({ name: `s${i}.json`, kind: 'file', mtimeMs: 0 }))
    expect(SESSION_PRUNE_LIMIT).toBe(500)
    expect(staleSessionFiles(entries, now, 'own.json')).toHaveLength(500)
  })
})
