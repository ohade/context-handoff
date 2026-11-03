// FIXTURE: relocate only the public resources and give subprocesses an absent home.
import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

import { allowInRun } from '../../hooks/allowlist'
import { parseTemplate } from '../../hooks/brief'
import type { RunContext } from '../../hooks/allowlist'

const scratch = mkdtempSync(join(tmpdir(), 'context-handoff-package-'))
const relocated = join(scratch, 'mods', 'context-handoff')
const packageRoot = join(import.meta.dir, '..', '..')
const home = join(scratch, 'absent-home')
const briefDir = join(scratch, 'briefs')
const sessionId = randomUUID()
mkdirSync(relocated, { recursive: true })
cpSync(join(packageRoot, 'skills'), join(relocated, 'skills'), { recursive: true })
cpSync(join(packageRoot, 'scripts'), join(relocated, 'scripts'), { recursive: true })
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const skill = readFileSync(join(relocated, 'skills', 'compact-crafter', 'SKILL.md'), 'utf8')
const documentedScripts = [...skill.matchAll(/`python3 (?:"([^"]+)"|(\S+)) /g)]
  .map(match => (match[1] ?? match[2]) as string)

function scriptPath(name: string): string {
  const documented = documentedScripts.find(path => path.endsWith(`/${name}`))
  expect(documented, `${name} must be documented`).toBeDefined()
  return (documented as string)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', relocated)
    .replace(/^~(?=\/)/, home)
}

test('documented helpers and extractor load entirely from a relocated plugin', () => {
  expect(existsSync(home)).toBe(false)
  for (const name of ['snapshot-path.py', 'check-snapshot.py', 'transcript-facts.py']) {
    const path = scriptPath(name)
    expect(path.startsWith(`${relocated}${sep}`), `${name} must come from the relocated plugin`).toBe(true)
    expect(existsSync(path), `${name} must be included`).toBe(true)
  }

  const template = parseTemplate(readFileSync(join(relocated, 'skills', 'compact-crafter', 'reference', 'snapshot-template.md'), 'utf8'))
  expect(template).not.toHaveProperty('failure')
  const environment = { ...process.env, HOME: home }
  const allocated = spawnSync('python3', [scriptPath('snapshot-path.py'), '--session', sessionId, '--dir', briefDir], {
    env: environment, encoding: 'utf8',
  })
  expect({ status: allocated.status, stderr: allocated.stderr }).toEqual({ status: 0, stderr: '' })
  expect(allocated.stdout).toContain(`path=${join(briefDir, sessionId)}-`)

  const transcript = join(scratch, 'synthetic.jsonl')
  writeFileSync(transcript, `${JSON.stringify({
    type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Continue the synthetic sample task.' },
  })}\n`)
  const facts = spawnSync('python3', [scriptPath('transcript-facts.py'), transcript, '--markdown', '--user-requests'], {
    env: environment, encoding: 'utf8',
  })
  expect({ status: facts.status, stderr: facts.stderr }).toEqual({ status: 0, stderr: '' })
  expect(facts.stdout).toContain('## Facts from the transcript')
  expect(facts.stdout).toContain('Continue the synthetic sample task.')
})

test('the automatic allowlist refuses helpers outside the packaged skill', () => {
  const context: RunContext = {
    handoffTool: 'mcp__context-handoff__handoff_now', repoRoot: relocated,
    home, briefDir, sessionId, transcriptPath: join(scratch, 'synthetic.jsonl'),
  }
  const command = `python3 ${join(home, '.claude', 'skills', 'compact-crafter', 'scripts', 'snapshot-path.py')} --session ${sessionId}`
  expect(allowInRun({ tool: 'Bash', input: { command } }, context, path => ({ real: path }))).toHaveProperty('deny')
})
