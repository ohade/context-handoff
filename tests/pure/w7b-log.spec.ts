// W7 Phase B, item K (audit P4: R1-F9). Written red-first. handoff.log holds the first 60
// characters of each typed prompt, so the log writer creates and keeps it, and its rotated copy,
// at mode 0600. Runs the real appendArgv command with sh in a temp folder.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendArgv } from '../../hooks/log'

const mode = (path: string) => statSync(path).mode & 0o777
const append = (path: string, line: string) => {
  const run = Bun.spawnSync(appendArgv(path, line))
  expect(run.exitCode).toBe(0)
}

describe('[K] handoff.log is private', () => {
  test('a new log, in a new folder, is created 0600', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'w7b-log-')), 'state', 'handoff.log')
    append(path, 'turn-start text="secret"')
    expect(mode(path).toString(8)).toBe('600')
  })

  test('an existing log with a looser mode is tightened on the next append', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'w7b-log-')), 'handoff.log')
    writeFileSync(path, 'old\n')
    chmodSync(path, 0o644)
    append(path, 'line')
    expect(mode(path).toString(8)).toBe('600')
  })

  test('the rotated copy is 0600 too', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'w7b-log-')), 'handoff.log')
    writeFileSync(path, 'x'.repeat(5_000_001))
    chmodSync(path, 0o644)
    append(path, 'after rotation')
    expect(mode(`${path}.1`).toString(8)).toBe('600')
    expect(mode(path).toString(8)).toBe('600')
  })
})

describe('[K r1] the log folder is created private', () => {
  test('a new state folder is created 0700 (umask 077), so the log is never readable in between', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'w7b-log-')), 'state')
    const before = process.umask(0o022) // a runner already at 077 would make this pass without the script's umask
    try {
      append(join(dir, 'handoff.log'), 'line')
    } finally {
      process.umask(before)
    }
    expect(mode(dir).toString(8)).toBe('700')
  })
})
