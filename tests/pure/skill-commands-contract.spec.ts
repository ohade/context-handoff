import { fixturePath } from '../fixtures/paths'

// Review finding cc M6 (2026-10-20): the skill's text test copied the allowlist patterns loosely and
// accepted four commands the mod denies. This contract test reads the commands SKILL.md documents
// for an automatic run and checks them against the mod's real allowlist.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { allowInRun } from '../../hooks/allowlist'
import type { RunContext } from '../../hooks/allowlist'

const SID = '11111111-aaaa-4bbb-8ccc-000000000001'
const DIR = fixturePath('home/.claude/state/compact-handoffs')
const ctx: RunContext = {
  handoffTool: 'mcp__context-handoff__handoff_now', repoRoot: fixturePath('repo'), home: fixturePath('home'), briefDir: DIR, sessionId: SID,
  transcriptPath: fixturePath('home/.claude/projects/p/s.jsonl'),
}
const lands = (path: string) => ({ real: path })
const bash = (command: string) => allowInRun({ tool: 'Bash', input: { command } }, ctx, lands)
const skill = readFileSync(new URL('../../skills/compact-crafter/SKILL.md', import.meta.url), 'utf8')
const paragraph = skill.slice(skill.indexOf('**Automatic run.**'), skill.indexOf('\n\n', skill.indexOf('**Automatic run.**')))
const documented = [...paragraph.matchAll(/`((?:python3|find) [^`]+)`/g)].map(match => match[1] as string)

test('the automatic-run paragraph documents exactly three commands', () => {
  expect(documented).toHaveLength(3)
})

test('each documented command, filled in, is allowed by the real allowlist', () => {
  for (const command of documented) {
    const filled = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', ctx.repoRoot).replaceAll('<session>', SID).replace('<snapshot>', `${DIR}/${SID}-20261020-1200-1.md`)
    expect({ command: filled, verdict: bash(filled) }).toEqual({ command: filled, verdict: { allow: true } })
  }
})

test.each([
  `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/snapshot-path.py --session $SID`,
  `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/snapshot-path.py --session ${SID} --dir ${fixturePath('tmp/elsewhere')}`,
  `python3 ${ctx.repoRoot}/skills/compact-crafter/scripts/check-snapshot.py ${fixturePath(`tmp/${SID}-20261020-1200-1.md`)}`,
  `find ~/.claude/projects -maxdepth 2 -name "$(id).jsonl" | head -1`,
])('a near miss of a documented command is denied: %s', command => {
  expect(bash(command)).not.toEqual({ allow: true })
})
