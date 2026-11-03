// FIXTURE: synthetic host-helper outcomes exercise the plugin latch reader on real files.
// Only regular carried markers naming the receiving session release the prior latch.
// A resumed source with a new unapproved generation is carried again.
// These checks do not certify the optional host helper implementation.
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRetroLatchFiles, retroLatchSource } from '../../hooks/retro-latch'
import type { RetroLatchFs } from '../../hooks/retro-latch'

const P = '11111111-aaaa-4bbb-8ccc-000000000001'
const N = '22222222-aaaa-4bbb-8ccc-000000000002'
const N2 = '33333333-aaaa-4bbb-8ccc-000000000003'
const X = '44444444-aaaa-4bbb-8ccc-000000000004'
const LATCHED_P = { active: true, approved: false, sourceId: P }
const NO_LATCH = { active: false, approved: false }
const NONE = { active: false, approved: false, carried: false }
const CASES = join(import.meta.dir, '../fixtures/retro-carried-marker-cases.tsv')

/** The real file system, answered the way the engine's $.fs.exists, $.fs.stat and $.fs.read answer. */
const realFs: RetroLatchFs = {
  exists: async path => existsSync(path),
  stat: async path => {
    const own = lstatSync(path)
    const target = own.isSymbolicLink() ? statSync(path) : own
    return { kind: target.isFile() ? 'file' : target.isDirectory() ? 'dir' : 'other', isLink: own.isSymbolicLink() }
  },
  read: async path => readFileSync(path, 'utf8'),
}

/** A fresh home with an empty retro state folder (0700, as retro-gate.sh makes it). */
function freshHome(): { home: string; retro: string } {
  const home = mkdtempSync(join(tmpdir(), 'track23-v4-'))
  const retro = join(home, '.claude/state/retro')
  mkdirSync(retro, { recursive: true, mode: 0o700 })
  return { home, retro }
}

describe('TRACK-23 v4 G1d: only a regular carried- file counts', () => {
  test('a carried- folder or symbolic link is absent, so the previous latch is still the source', async () => {
    const { home, retro } = freshHome()
    writeFileSync(join(retro, `active-${P}`), '1\n')
    mkdirSync(join(retro, `carried-${P}`))
    expect((await readRetroLatchFiles(realFs, home, P, N))?.carried).toBe(false)
    expect(retroLatchSource(N, NONE, P, await readRetroLatchFiles(realFs, home, P, N))).toEqual(LATCHED_P)

    const linked = freshHome()
    writeFileSync(join(linked.retro, `active-${P}`), '1\n')
    writeFileSync(join(linked.home, 'link-target'), `${N}\n`)
    symlinkSync(join(linked.home, 'link-target'), join(linked.retro, `carried-${P}`))
    expect((await readRetroLatchFiles(realFs, linked.home, P, N))?.carried).toBe(false)
    expect(retroLatchSource(N, NONE, P, await readRetroLatchFiles(realFs, linked.home, P, N))).toEqual(LATCHED_P)
  })

  test('a regular carried- file counts, and a stat that fails is absent', async () => {
    const { home, retro } = freshHome()
    writeFileSync(join(retro, `active-${P}`), '1\n')
    writeFileSync(join(retro, `carried-${P}`), `${N}\n`)
    expect(await readRetroLatchFiles(realFs, home, P, N)).toEqual({ active: true, approved: false, carried: true })
    const failing: RetroLatchFs = { ...realFs, exists: async () => true, stat: async path => { throw new Error(`EACCES: ${path}`) } }
    expect((await readRetroLatchFiles(failing, home, P, N))?.carried).toBe(false)
    expect(await readRetroLatchFiles(realFs, home, '../x', N)).toBeNull()
  })
})

describe('TRACK-23 v4 G2: a resumed session starts a fresh latch generation', () => {
  test('synthetic resumed-source state: P is the unapproved latch N2 carries', async () => {
    const { home, retro } = freshHome()
    // End-state fixture: a new unapproved source generation; its successor has no own latch.
    writeFileSync(join(retro, `active-${P}`), '1\n')
    expect(readFileSync(join(retro, `active-${P}`), 'utf8')).toBe('1\n')
    // The carry P -> N2 failed: it wrote nothing, so N2 has no latch of its own.
    const own = await readRetroLatchFiles(realFs, home, N2, null)
    expect(own).toEqual({ active: false, approved: false, carried: false })
    expect(retroLatchSource(N2, own!, P, await readRetroLatchFiles(realFs, home, P, N2))).toEqual(LATCHED_P)
  })
})

/** The G4 case table: case, kind, content, decision; # lines are comments. */
const rows = readFileSync(CASES, 'utf8').split('\n').filter(line => line !== '' && !line.startsWith('#')).map(line => line.split('\t'))

/** The table's content tokens, expanded as the gate's shell test expands them (@PAD before @P). */
function expand(content: string): string {
  if (content === '-') return ''
  return content.replaceAll('@PAD', ' '.repeat(120)).replaceAll('@N', N).replaceAll('@X', X).replaceAll('@P', P)
    .replaceAll('\\n', '\n').replaceAll('\\r', '\r').replaceAll('\\0', '\0')
}

describe('TRACK-23 v5 G4b: carried-<previous> releases only when it names this session', () => {
  test('the case table has 16 rows of four columns', () => {
    expect(rows.length).toBe(16)
    expect(rows.every(row => row.length === 4)).toBe(true)
  })

  for (const [name, kind, content, want] of rows) {
    test(`case ${name}: ${want}`, async () => {
      const { home, retro } = freshHome()
      writeFileSync(join(retro, `active-${P}`), '1\n')
      const marker = join(retro, `carried-${P}`)
      const text = expand(content!)
      if (kind === 'file' || kind === 'unreadable') writeFileSync(marker, text)
      if (kind === 'unreadable') chmodSync(marker, 0o000)
      if (kind === 'dir') mkdirSync(marker)
      if (kind === 'symlink') {
        writeFileSync(join(home, 'case-target'), text)
        symlinkSync(join(home, 'case-target'), marker)
      }
      const previous = await readRetroLatchFiles(realFs, home, P, N)
      expect(retroLatchSource(N, NONE, P, previous)).toEqual(want === 'latched' ? LATCHED_P : NO_LATCH)
    })
  }

  test('a synthetic carry marker releases only the successor it names', async () => {
    const { home, retro } = freshHome()
    writeFileSync(join(retro, `active-${P}`), '1\n')
    writeFileSync(join(retro, `carried-${P}`), `${X}\n`)
    expect(readFileSync(join(retro, `carried-${P}`), 'utf8')).toBe(`${X}\n`)
    expect(retroLatchSource(N, NONE, P, await readRetroLatchFiles(realFs, home, P, N))).toEqual(LATCHED_P)
    expect(retroLatchSource(X, NONE, P, await readRetroLatchFiles(realFs, home, P, X))).toEqual(NO_LATCH)
  })
})
