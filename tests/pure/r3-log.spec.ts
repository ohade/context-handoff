// rotation must not race, and a failed rotation must never drop the line.
// Runs the real `sh` argv against a temp folder.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendArgv } from '../../hooks/log'

const dirs: string[] = []
afterEach(() => {
  // Scratch goes to the Trash, never rm -rf.
  for (const d of dirs.splice(0)) renameSync(d, join(homedir(), '.Trash', `ctx-handoff-logspec-${Date.now()}-${Math.random().toString(36).slice(2)}`))
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ctx-handoff-log-'))
  dirs.push(d)
  return d
}

function run(argv: string[]): number {
  return Bun.spawnSync(argv).exitCode ?? -1
}

const BIG = 'x'.repeat(5_000_001)

describe('[low] log rotation', () => {
  test('a failed rotation still appends the line', () => {
    const d = scratch()
    const log = join(d, 'handoff.log')
    writeFileSync(log, BIG)
    mkdirSync(`${log}.1`) // mv -f onto a directory moves INTO it; make the target unwritable instead
    mkdirSync(join(`${log}.1`, 'handoff.log'))
    run(appendArgv(log, 'kept line'))
    const current = existsSync(log) ? readFileSync(log, 'utf8') : ''
    const nested = existsSync(join(`${log}.1`, 'handoff.log')) && statSync(join(`${log}.1`, 'handoff.log')).isFile()
      ? readFileSync(join(`${log}.1`, 'handoff.log'), 'utf8') : ''
    expect(`${current}${nested}`.includes('kept line\n')).toBe(true)
  })

  test('no rotation while another writer holds the rotation lock; the line is appended', () => {
    const d = scratch()
    const log = join(d, 'handoff.log')
    writeFileSync(log, BIG)
    mkdirSync(`${log}.lock`)
    expect(run(appendArgv(log, 'locked line'))).toBe(0)
    expect(existsSync(`${log}.1`)).toBe(false)
    expect(readFileSync(log, 'utf8').endsWith('locked line\n')).toBe(true)
  })

  test('past 5 MB with no lock held: rotate to .1, release the lock, append to a fresh file', () => {
    const d = scratch()
    const log = join(d, 'handoff.log')
    writeFileSync(log, BIG)
    expect(run(appendArgv(log, 'fresh line'))).toBe(0)
    expect(statSync(`${log}.1`).size).toBe(BIG.length)
    expect(statSync(log).size).toBe('fresh line\n'.length)
    expect(existsSync(`${log}.lock`)).toBe(false)
  })

  test('a lock left by a killed writer (older than 5 minutes) is stale: rotation happens and the lock is gone', () => {
    const d = scratch()
    const log = join(d, 'handoff.log')
    writeFileSync(log, BIG)
    mkdirSync(`${log}.lock`)
    const old = (Date.now() - 10 * 60_000) / 1000
    utimesSync(`${log}.lock`, old, old)
    expect(run(appendArgv(log, 'after stale lock'))).toBe(0)
    expect(statSync(`${log}.1`).size).toBe(BIG.length)
    expect(statSync(log).size).toBe('after stale lock\n'.length)
    expect(existsSync(`${log}.lock`)).toBe(false)
  })
})
