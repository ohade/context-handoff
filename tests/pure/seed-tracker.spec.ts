import { fixturePath } from '../fixtures/paths'

// Seed item 0: the fresh session restores the tracker first, from the old session's full id, in both
// modes; the existing items keep their order after it (restore-first ordering). Red-first.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { composeBrief, extractSections, instructionsFor, parseTemplate, verifyBrief } from '../../hooks/brief'
import type { Template } from '../../hooks/brief'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
const SESSION = '22222222-aaaa-4bbb-8ccc-000000000002'
const ITEM_0 = (sid: string) =>
  `0. Before continuation, verify Track restoration. Read this brief's .track.json sidecar. A null checkpoint means Track was absent. Otherwise call \`mcp__track__restore_tracker\` with \`from_session\` set to \`${sid}\` and \`expected_checkpoint\` copied from the sidecar, without \`replace\`, unless the seed note already contains the matching verified restore receipt. Require a successful v1 JSON text receipt for this destination session with matching revision, checksum, counts and applied_checksum. A missing, refused or incompatible full restoration means stop and report; never substitute steps-only restoration.`
const FACTS = `## Facts from the transcript\nSource: ${fixturePath('t.jsonl')} (generated 2026-10-04T20:00:00Z)\n### Files edited\n- none\n### Commits\n- none\n### Tickets\n- none\n### Last user request\n- none`
const HEADER = { session: SESSION, previous: 'none', transcript: fixturePath(`Users/x${fixturePath('t.jsonl')}`), created: '2026-10-04T22:40:00+03:00', tokens: 712345 }

function template(): Template {
  const t = parseTemplate(readFileSync(join(FIXTURES, 'template.md'), 'utf8'))
  if ('failure' in t) throw new Error(t.failure)
  return t
}

describe('instructionsFor item 0', () => {
  for (const mode of ['continue', 'wait'] as const) {
    test(`${mode}: item 0 restores the tracker with the full session id, then items 1-5 in order`, () => {
      const items = instructionsFor(mode, SESSION)
      expect(items[0]).toBe(ITEM_0(SESSION))
      expect(items.slice(1).map(i => i.slice(0, 3))).toEqual(['1. ', '2. ', '3. ', '4. ', '5. '])
    })
  }
})

describe('the composed brief', () => {
  for (const status of ['partial', 'answered'] as const) {
    test(`status ${status}: item 0 carries the header's session value and the brief verifies`, () => {
      const sections = (extractSections(readFileSync(join(FIXTURES, 'sections.md'), 'utf8'), template()) as string).replace('Status: partial', `Status: ${status}`)
      const text = composeBrief(template(), HEADER, sections, FACTS) as string
      expect(verifyBrief(text, template())).toEqual({ ok: true, mode: status === 'answered' ? 'wait' : 'continue' })
      const lines = text.split('\n')
      const at = lines.indexOf('## Instructions for the fresh session')
      expect(lines[at + 1]).toBe(ITEM_0(SESSION))
      expect(lines[at + 2]?.startsWith('1. ')).toBe(true)
    })
  }
})
