import { fixturePath } from '../fixtures/paths'

// Armed-run paths must stay inside the allowed snapshot roots, including resolved targets.
// 1. In the armed window check-snapshot.py's argument names a file under the brief folder, by the
//    Write rule: `<briefDir>/<sid>-*.md`, bare or quoted. Any other readable path is refused.
// 2. Read, Write and the check-snapshot argument are checked where the path LANDS too: the hook
//    resolves each spelling with $.fs.stat({ resolve: true }) and passes the landings in; a symlink
//    out of an allowed root, a link that leads nowhere, or a root that does not resolve is refused.
import { describe, expect, test } from 'bun:test'

import { allowInRun, resolveTargets } from '../../hooks/allowlist'
import type { Landing, RunContext } from '../../hooks/allowlist'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const OTHER = '22222222-aaaa-4bbb-8ccc-000000000002'
const DIR = fixturePath('home/.claude/state/compact-handoffs')
const SNAP = `${DIR}/${SID}-20261006-1200-1.md`
const SCRIPT = fixturePath('repo/skills/compact-crafter/scripts/check-snapshot.py')
const ctx: RunContext = {
  handoffTool: 'mcp__context-handoff__handoff_now', repoRoot: fixturePath('repo'), home: fixturePath('home'), briefDir: DIR, sessionId: SID,
  transcriptPath: fixturePath('home/.claude/projects/p/s.jsonl'),
}
const ok = { allow: true }

/** Every spelling lands on itself unless `over` says otherwise. */
const lands = (over: Record<string, Landing> = {}) => (path: string): Landing => over[path] ?? { real: path }
const check = (arg: string, resolve = lands()) => allowInRun({ tool: 'Bash', input: { command: `python3 ${SCRIPT} ${arg}` } }, ctx, resolve)
const read = (file_path: string, resolve = lands()) => allowInRun({ tool: 'Read', input: { file_path } }, ctx, resolve)
const write = (file_path: string, resolve = lands()) => allowInRun({ tool: 'Write', input: { file_path } }, ctx, resolve)

describe('[J] check-snapshot.py names only <briefDir>/<sid>-*.md', () => {
  test('the snapshot in the brief folder passes, bare or quoted', () => {
    expect(check(SNAP)).toEqual(ok)
    expect(check(`"${SNAP}"`)).toEqual(ok)
    expect(check(`'${SNAP}'`)).toEqual(ok)
  })

  test.each([
    fixturePath('etc/passwd'),
    fixturePath('home/.ssh/id_rsa'),
    '~/.ssh/id_rsa',
    `${DIR}/${OTHER}-20261006-1200-1.md`,
    `${DIR}/${SID}-20261006-1200-1.txt`,
    `${DIR}/sub/${SID}-x.md`,
    `${DIR}/../${SID}-x.md`,
    fixturePath(`repo/skills/compact-crafter/${SID}-x.md`),
    `"${fixturePath('etc/passwd')}"`,
  ])('refused, lexically: %p', arg => {
    expect('deny' in check(arg)).toBe(true)
    expect('deny' in allowInRun({ tool: 'Bash', input: { command: `python3 ${SCRIPT} ${arg}` } }, ctx)).toBe(true)
  })

  test('refused when the snapshot is a link out of the brief folder, leads nowhere, or is missing', () => {
    expect('deny' in check(SNAP, lands({ [SNAP]: { real: fixturePath('home/.ssh/id_rsa') } }))).toBe(true)
    expect('deny' in check(`"${SNAP}"`, lands({ [SNAP]: { real: fixturePath('home/.ssh/id_rsa') } }))).toBe(true)
    expect('deny' in check(SNAP, lands({ [SNAP]: 'nowhere' }))).toBe(true)
    expect('deny' in check(SNAP, lands({ [SNAP]: 'missing' }))).toBe(true)
  })

  test('the hook is told to resolve the unquoted argument and the brief folder', () => {
    expect(resolveTargets({ tool: 'Bash', input: { command: `python3 ${SCRIPT} "${SNAP}"` } }, ctx)).toEqual([SNAP, DIR])
  })
})

describe('[J] Read and Write are checked where the path lands', () => {
  test('a Read of a link in the brief folder that lands outside every root is refused', () => {
    expect(read(SNAP)).toEqual(ok)
    expect('deny' in read(SNAP, lands({ [SNAP]: { real: fixturePath('home/.ssh/id_rsa') } }))).toBe(true)
    expect('deny' in read(fixturePath('repo/skills/compact-crafter/SKILL.md'), lands({ [fixturePath('repo/skills/compact-crafter/SKILL.md')]: { real: fixturePath('etc/passwd') } }))).toBe(true)
    expect('deny' in read(SNAP, lands({ [SNAP]: 'nowhere' }))).toBe(true)
    expect('deny' in read(SNAP, lands({ [SNAP]: 'missing' }))).toBe(true)
  })

  test('roots are resolved the same way: a brief folder behind a link still admits its own files', () => {
    const real = fixturePath('private/briefs')
    const resolve = lands({ [DIR]: { real }, [SNAP]: { real: `${real}/${SID}-20261006-1200-1.md` } })
    expect(read(SNAP, resolve)).toEqual(ok)
    expect(write(SNAP, resolve)).toEqual(ok)
    expect(check(SNAP, resolve)).toEqual(ok)
    expect('deny' in read(SNAP, lands({ [DIR]: { real }, [SNAP]: { real: fixturePath('home/.ssh/id_rsa') } }))).toBe(true)
    expect('deny' in read(SNAP, lands({ [DIR]: 'nowhere' }))).toBe(true)
  })

  test('the transcript passes where it lands; a Read of its subagents folder follows the same rule', () => {
    expect(read(fixturePath('home/.claude/projects/p/s.jsonl'))).toEqual(ok)
    expect(read(fixturePath('home/.claude/projects/p/s/subagents/a.jsonl'))).toEqual(ok)
    // The transcript spelling comes from the engine, so where it lands is the transcript; a file in its subagents folder is the model's.
    const agent = fixturePath('home/.claude/projects/p/s/subagents/a.jsonl')
    expect('deny' in read(agent, lands({ [agent]: { real: fixturePath('etc/passwd') } }))).toBe(true)
  })

  test('Write: a new file (missing) passes; an existing link out, or a link that leads nowhere, is refused', () => {
    expect(write(SNAP, lands({ [SNAP]: 'missing' }))).toEqual(ok)
    expect('deny' in write(SNAP, lands({ [SNAP]: { real: fixturePath('home/.bashrc') } }))).toBe(true)
    expect('deny' in write(SNAP, lands({ [SNAP]: 'nowhere' }))).toBe(true)
    expect('deny' in write(SNAP, lands({ [SNAP]: 'missing', [DIR]: 'missing' }))).toBe(true)
  })

  test('the hook is told to resolve each Read root and the target', () => {
    const targets = resolveTargets({ tool: 'Read', input: { file_path: SNAP } }, ctx)
    expect(targets).toContain(SNAP)
    expect(targets).toContain(DIR)
    expect(targets).toContain(fixturePath('repo/skills/compact-crafter'))
    expect(targets).not.toContain(fixturePath('home/.claude/skills/compact-crafter'))
    expect(targets).toContain(fixturePath('home/.claude/projects/p/s.jsonl'))
    expect(resolveTargets({ tool: 'Write', input: { file_path: SNAP } }, ctx)).toEqual([SNAP, DIR])
    expect(resolveTargets({ tool: 'Bash', input: { command: 'date' } }, ctx)).toEqual([])
  })
})

describe('[J r1] nothing is resolved for a spelling the lexical rule refuses; only ASCII space is trimmed', () => {
  test('resolveTargets names no path for a Read, Write or check-snapshot.py argument that is refused by spelling', () => {
    expect(resolveTargets({ tool: 'Read', input: { file_path: fixturePath('net/host/share/x') } }, ctx)).toEqual([])
    expect(resolveTargets({ tool: 'Read', input: { file_path: `${DIR}/../x.md` } }, ctx)).toEqual([])
    expect(resolveTargets({ tool: 'Write', input: { file_path: fixturePath('tmp/x.md') } }, ctx)).toEqual([])
    expect(resolveTargets({ tool: 'Write', input: { file_path: `${DIR}/${OTHER}-x.md` } }, ctx)).toEqual([])
    expect(resolveTargets({ tool: 'Bash', input: { command: `python3 ${SCRIPT} ${fixturePath('etc/passwd')}` } }, ctx)).toEqual([])
  })

  test('a command ending in a non-breaking space is refused (bash would pass it on as part of the argument)', () => {
    expect('deny' in check(`${SNAP} `)).toBe(true)
    expect('deny' in allowInRun({ tool: 'Bash', input: { command: `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/snapshot-path.py --session ${SID} ` } }, ctx, lands())).toBe(true)
    expect(check(`${SNAP} \n`)).toEqual(ok)
    expect('deny' in check(`${SNAP}\r`), 'bash keeps a CR in the argument').toBe(true)
  })
})

describe('[security review] the run writes only ASCII snapshot names', () => {
  test('a Write name outside [A-Za-z0-9_.-] is refused by spelling, and nothing is resolved for it', () => {
    for (const name of [`${SID}-café.md`, `${SID}-ſnap.md`, `${SID}-a b.md`, `${SID}-K.md`]) {
      expect('deny' in write(`${DIR}/${name}`)).toBe(true)
      expect(resolveTargets({ tool: 'Write', input: { file_path: `${DIR}/${name}` } }, ctx)).toEqual([])
    }
    expect(write(`${DIR}/${SID}-20261007-0900-1.md`)).toEqual(ok)
  })
})

describe('review findings ch L4, L15 (2026-10-20)', () => {
  test('L4: a Read of another session\'s brief or snapshot is denied; this session\'s is allowed', () => {
    expect(read(`${DIR}/${OTHER}-20261006-1200-1.md`)).not.toEqual(ok)
    expect(read(`${DIR}/${OTHER}-20261006-1200-1.md.track.json`)).not.toEqual(ok)
    expect(read(SNAP)).toEqual(ok)
  })

  test('L4: find may name only this session\'s transcript, never a glob over every session', () => {
    const find = (name: string) => allowInRun({ tool: 'Bash', input: { command: `find ~/.claude/projects -maxdepth 2 -name ${name} | head -1` } }, ctx, lands())
    expect(find(`"${SID}.jsonl"`)).toEqual(ok)
    expect(find('"*.jsonl"')).not.toEqual(ok)
    expect(find('"*"')).not.toEqual(ok)
  })

  test('L15: an unquoted --dir is refused when the brief folder holds shell metacharacters', () => {
    const bad = { ...ctx, briefDir: fixturePath('home/briefs;touch pwned') }
    const command = `python3 ${SCRIPT.replace('check-snapshot', 'snapshot-path')} --session ${SID} --dir ${bad.briefDir}`
    expect(allowInRun({ tool: 'Bash', input: { command } }, bad, lands())).not.toEqual(ok)
  })
})
