import { fixturePath } from '../fixtures/paths'

// W2b Phase 1: the own-skill origin, the armed door of handoff_now, the armed-window allowlist,
// cycle-suffixed brief names and the config of the automatic run.
import { describe, expect, test } from 'bun:test'

import { allowInRun } from '../../hooks/allowlist'
import type { RunContext } from '../../hooks/allowlist'
import { briefFileName } from '../../hooks/brief'
import { resolveConfig } from '../../hooks/config'
import { checkArmedSnapshot, gateHandoffNow, HANDOFF_NOW_REFUSAL } from '../../hooks/handoff-now'
import { autoRunCycleOf, originOf } from '../../hooks/turns'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const CYCLE = `${SID}#3`
const RUN_PROMPT = `/context-handoff:compact-crafter automatic-run cycle=${CYCLE} session=${SID}`

describe('own-skill origin (the live probe labelled the run own-seed: a bug)', () => {
  test('the cycle is read from the run prompt, exactly', () => {
    expect(autoRunCycleOf(RUN_PROMPT)).toBe(CYCLE)
    expect(autoRunCycleOf('/compact-crafter')).toBeNull()
    expect(autoRunCycleOf(`/context-handoff:compact-crafter automatic-run cycle= session=${SID}`)).toBeNull()
    expect(autoRunCycleOf(`hello /context-handoff:compact-crafter automatic-run cycle=${CYCLE} session=${SID}`)).toBeNull()
  })

  test('own plugin + the armed cycle is own-skill; another cycle is other; the seed stays own-seed', () => {
    const own = { kind: 'plugin', name: 'context-handoff' }
    expect(originOf(own, 'context-handoff', RUN_PROMPT, CYCLE)).toBe('own-skill')
    expect(originOf(own, 'context-handoff', RUN_PROMPT, `${SID}#4`)).toBe('other')
    expect(originOf(own, 'context-handoff', RUN_PROMPT, null)).toBe('other')
    expect(originOf(own, 'context-handoff', 'Continue from the brief x.md', null)).toBe('own-seed')
    expect(originOf({ kind: 'plugin', name: 'other-plugin' }, 'context-handoff', RUN_PROMPT, CYCLE)).toBe('other')
    expect(originOf({ kind: 'composer' }, 'context-handoff', RUN_PROMPT, CYCLE)).toBe('composer')
  })
})

describe('handoff_now doors', () => {
  const turn = (origin: 'composer' | 'own-skill' | 'other' | 'own-seed', promptText = '/compact-crafter') => ({ turnId: 't2', origin, promptText, turnText: '' })

  test('composer door unchanged; the armed door opens only for a turn the run bound', () => {
    expect(gateHandoffNow(turn('composer'), undefined, false)).toEqual({ queue: 'manual' })
    expect(gateHandoffNow(turn('own-skill', RUN_PROMPT), undefined, true)).toEqual({ queue: 'auto' })
    expect(gateHandoffNow(turn('other', ''), undefined, true)).toEqual({ queue: 'auto' })
    expect(gateHandoffNow(turn('own-skill', RUN_PROMPT), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    expect(gateHandoffNow(turn('own-seed', ''), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    expect(gateHandoffNow(turn('own-skill', RUN_PROMPT), 'agent-1', true)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
  })

  test('the refusal names handoff_now, not the old compact_now wording', () => {
    expect(HANDOFF_NOW_REFUSAL).not.toContain('not user-initiated: show the instructions and ask')
    expect(HANDOFF_NOW_REFUSAL).toMatch(/^handoff_now refused: /)
  })

  test('armed snapshot: under the brief dir, named and headed with the current full session id', () => {
    const dir = fixturePath('home/.claude/state/compact-handoffs')
    const good = `${dir}/${SID}-20261005-2003-1.md`
    const text = (session: string) => `# Snapshot\n<!-- header -->\nsession: ${session}\nprevious: none\n<!-- /header -->\n`
    expect(checkArmedSnapshot(good, text(SID), dir, SID)).toBeNull()
    expect(checkArmedSnapshot(fixturePath(`tmp/${SID}-20261005-2003-1.md`), text(SID), dir, SID)).toMatch(/under/)
    expect(checkArmedSnapshot(`${dir}/../x/${SID}-20261005-2003-1.md`, text(SID), dir, SID)).toMatch(/under/)
    const other = '22222222-aaaa-4bbb-8ccc-000000000002'
    expect(checkArmedSnapshot(`${dir}/${other}-20261005-2003-1.md`, text(SID), dir, SID)).toMatch(/file name/)
    expect(checkArmedSnapshot(good, text(other), dir, SID)).toMatch(/header session/)
    expect(checkArmedSnapshot(good, text(SID.slice(0, 8)), dir, SID)).toMatch(/header session/)
  })
})

describe('armed-window allowlist', () => {
  const ctx: RunContext = { handoffTool: 'mcp__context-handoff__handoff_now', repoRoot: fixturePath('repo'), home: fixturePath('home'), briefDir: fixturePath('home/.claude/state/compact-handoffs'), sessionId: SID, transcriptPath: null }
  const bash = (command: string) => allowInRun({ tool: 'Bash', input: { command } }, ctx)
  const ok = { allow: true }

  test('handoff_now and Read pass; other tools are denied', () => {
    expect(allowInRun({ tool: 'mcp__context-handoff__handoff_now', input: {} }, ctx)).toEqual(ok)
    expect(allowInRun({ tool: 'Read', input: { file_path: fixturePath('repo/skills/compact-crafter/SKILL.md') } }, ctx)).toEqual(ok)
    // W2d fix 5: Read outside the brief folder, the skill folders and the transcript is denied.
    expect('deny' in allowInRun({ tool: 'Read', input: { file_path: fixturePath('repo/x') } }, ctx)).toBe(true)
    for (const tool of ['Edit', 'Agent', 'WebFetch', 'mcp__other__x', 'NotebookEdit']) expect('deny' in allowInRun({ tool, input: {} }, ctx)).toBe(true)
  })

  test('Write only to <briefDir>/<sid>-*.md', () => {
    const write = (file_path: string) => allowInRun({ tool: 'Write', input: { file_path } }, ctx)
    expect(write(`${ctx.briefDir}/${SID}-20261005-2003-1.md`)).toEqual(ok)
    expect('deny' in write(`${ctx.briefDir}/22222222-aaaa-4bbb-8ccc-000000000002-20261005-2003-1.md`)).toBe(true)
    expect('deny' in write(`${ctx.briefDir}/${SID}-x/../../evil.md`)).toBe(true)
    expect('deny' in write(`${ctx.briefDir}/${SID}-x.sh`)).toBe(true)
    expect('deny' in write(fixturePath('home/.bashrc'))).toBe(true)
  })

  test('Bash: exactly the two skill scripts and find under ~/.claude/projects', () => {
    for (const root of [fixturePath('repo/skills/compact-crafter/scripts')]) {
      expect(bash(`python3 ${root}/snapshot-path.py --session ${SID}`)).toEqual(ok)
      expect(bash(`python3 ${root}/snapshot-path.py --session ${SID} --dir ${ctx.briefDir}`)).toEqual(ok)
      // W2d fix 4: --dir names only the brief folder.
      expect('deny' in bash(`python3 ${root}/snapshot-path.py --session ${SID} --dir ${fixturePath('tmp/briefs')}`)).toBe(true)
      expect(bash(`python3 ${root}/check-snapshot.py ${ctx.briefDir}/${SID}-20261005-2003-1.md`)).toEqual(ok)
      expect(bash(`python3 ${root}/check-snapshot.py "${ctx.briefDir}/${SID}-20261005-2003-1.md"`)).toEqual(ok)
    }
    expect(bash(`find ~/.claude/projects -maxdepth 2 -name "${SID}.jsonl"`)).toEqual(ok)
    expect(bash(`find ~/.claude/projects -maxdepth 2 -name "${SID}.jsonl" | head -1`)).toEqual(ok)
    // A glob lists every session's transcript name; only this session's name is allowed.
    expect(bash(`find ${ctx.home}/.claude/projects -maxdepth 2 -name "*.jsonl"`)).not.toEqual(ok)
    expect(bash(`find ${ctx.home}/.claude/projects -maxdepth 2 -name "${SID}.jsonl"`)).toEqual(ok)
    expect(bash(`find ~/.claude/projects -maxdepth 2 -name '${SID}.jsonl' | head -1`)).toEqual(ok)
  })

  test('substitution or escapes inside quotes never pass', () => {
    const denied = [
      'find ~/.claude/projects -maxdepth 2 -name "$(id).jsonl"',
      'find ~/.claude/projects -maxdepth 2 -name "`id`"',
      'find ~/.claude/projects -name "x" -maxdepth "$(id)"',
      `find ~/.claude/projects -maxdepth 2 -name "${SID}.jsonl"; id`,
      `find ~/.claude/projects -maxdepth 2 -name "${SID}.jsonl" | sh`,
      `find ~/.claude/projects -maxdepth 2 -name "${SID}\\.jsonl"`,
      'find ~/.claude/projects -name "x"',
      `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/check-snapshot.py "$(id).md"`,
      `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/check-snapshot.py "a b.md"`,
      `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/snapshot-path.py --session ${SID} --dir "$(id)"`,
    ]
    for (const command of denied) expect('deny' in bash(command), command).toBe(true)
  })

  test('Bash: everything else is denied', () => {
    const denied = [
      `python3 ${ctx.home}/.claude/skills/compact-crafter/scripts/snapshot-path.py --session ${SID}`,
      `python3 ~/.claude/skills/compact-crafter/scripts/snapshot-path.py --session ${SID}`,
      `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/snapshot-path.py --session 22222222-aaaa-4bbb-8ccc-000000000002`,
      `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/check-snapshot.py x.md; rm -r ~`,
      `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/check-snapshot.py $(whoami)`,
      `python3 ${fixturePath('tmp/check-snapshot.py')} x.md`,
      `python3 -c "print(1)"`,
      'find ~/.claude/projects -name x -delete',
      'find ~/.claude/projects -exec rm {} +',
      'find ~/.claude/projects -name x | sh',
      `find ~/.claude/projects > ${fixturePath('tmp/out')}`,
      `find ${fixturePath('outside')} -name x`,
      'date',
      'git status',
      `for f in a b; do echo $f; done`,
    ]
    for (const command of denied) expect('deny' in bash(command), command).toBe(true)
  })
})

describe('brief names carry a cycle suffix (two runs in one minute never collide)', () => {
  test('the suffix is part of the name', () => {
    expect(briefFileName(SID, '20261005-2003', 1)).toBe(`${SID}-20261005-2003-1.md`)
    expect(briefFileName(SID, '20261005-2003', 2)).not.toBe(briefFileName(SID, '20261005-2003', 1))
  })
})

describe('config of the automatic run', () => {
  test('defaults: 400000 tokens, run timeout 180 s, tool cap 15; no fork timeout', () => {
    const { config, warnings } = resolveConfig({}, {})
    expect([config.thresholdTokens, config.thresholdPercent, config.autoRunTimeoutSeconds, config.autoRunToolCap]).toEqual([400_000, null, 180, 15])
    // No fork-era key of any name survives (W2c: broadened from the one timeout key).
    expect(Object.keys(config).filter(k => k.toLowerCase().includes('fork'))).toEqual([])
    expect(warnings).toEqual([])
  })

  test('whichever is set: a percent (env or option) replaces the token default; the token env wins over both', () => {
    expect(resolveConfig({ thresholdPercent: 80 }, {}).config).toMatchObject({ thresholdPercent: 80, thresholdTokens: null })
    expect(resolveConfig({}, { CONTEXT_HANDOFF_THRESHOLD_PERCENT: '60' }).config).toMatchObject({ thresholdPercent: 60, thresholdTokens: null })
    expect(resolveConfig({ thresholdPercent: 80 }, { CONTEXT_HANDOFF_THRESHOLD_TOKENS: '5000' }).config).toMatchObject({ thresholdPercent: null, thresholdTokens: 5_000 })
    expect(resolveConfig({ thresholdTokens: 300_000 }, {}).config).toMatchObject({ thresholdPercent: null, thresholdTokens: 300_000 })
  })

  test('run timeout and tool cap: env, option, range', () => {
    const c = resolveConfig({ autoRunToolCap: 5 }, { CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS: '60' }).config
    expect([c.autoRunTimeoutSeconds, c.autoRunToolCap]).toEqual([60, 5])
    const bad = resolveConfig({ autoRunToolCap: 0 }, { CONTEXT_HANDOFF_AUTO_RUN_TIMEOUT_SECONDS: '5' })
    expect([bad.config.autoRunTimeoutSeconds, bad.config.autoRunToolCap, bad.warnings.length]).toEqual([180, 15, 2])
  })
})
