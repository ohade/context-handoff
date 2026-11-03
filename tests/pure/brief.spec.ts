import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  briefFileName,
  composeBrief,
  extractSections,
  FACTS_HEADING,
  INSTRUCTIONS_HEADING,
  instructionsFor,
  localTime,
  parseTemplate,
  parseUtcOffset,
  statusOf,
  verifyBrief,
} from '../../hooks/brief'
import type { Template } from '../../hooks/brief'

const FIXTURES = join(import.meta.dir, '..', 'fixtures')
const TEMPLATE_TEXT = readFileSync(join(FIXTURES, 'template.md'), 'utf8')
/** A model's sections text with a chatty lead line and a stray fence (what a skill snapshot body may hold). */
const SECTIONS_TEXT = readFileSync(join(FIXTURES, 'sections.md'), 'utf8')
const SESSION = '22222222-aaaa-4bbb-8ccc-000000000002'
const FACTS = `## Facts from the transcript\nSource: ${fixturePath('t.jsonl')} (generated 2026-10-04T20:00:00Z)\n### Files edited\n- none\n### Commits\n- none\n### Tickets\n- none\n### Last user request\n- none`
const HEADER = { session: SESSION, previous: 'none', transcript: fixturePath(`Users/x${fixturePath('t.jsonl')}`), created: '2026-10-04T22:40:00+03:00', tokens: 712345 }

function template(): Template {
  const t = parseTemplate(TEMPLATE_TEXT)
  if ('failure' in t) throw new Error(t.failure)
  return t
}

function goodBrief(): string {
  const sections = extractSections(SECTIONS_TEXT, template()) as string
  return composeBrief(template(), HEADER, sections, FACTS) as string
}

describe('parseTemplate (C2)', () => {
  test('reads the header keys between the markers and the ten headings in order, with guidance', () => {
    const t = template()
    expect(t.headerKeys).toEqual(['session', 'previous', 'transcript', 'created'])
    expect(t.headings).toHaveLength(10)
    expect(t.headings[0]).toBe('## 1. Active goal and role')
    expect(t.headings[7]).toBe('## 8. Last request and status')
    expect(t.headings[9]).toBe('## 10. Assumptions to verify')
    expect(t.guidance[7]).toBe('One Status line.')
  })

  test('a template without markers, headings or section 8 is refused', () => {
    expect(parseTemplate('## 1. A\n')).toEqual({ failure: 'template: header markers missing' })
    expect(parseTemplate('<!-- header -->\nsession: x\n<!-- /header -->\n')).toEqual({ failure: 'template: no required headings' })
    expect(parseTemplate('<!-- header -->\nsession: x\n<!-- /header -->\n## 1. A\n')).toEqual({ failure: 'template: no section 8 for the Status line' })
  })
})

describe('compose and verify', () => {
  test('a composed brief verifies; mode is continue when the status is not answered', () => {
    const text = goodBrief()
    expect(verifyBrief(text, template())).toEqual({ ok: true, mode: 'continue' })
    const lines = text.split('\n')
    expect(lines.slice(0, 15)).toContain(`session: ${SESSION}`)
    expect(lines.slice(0, 15)).toContain('mode: continue')
    expect(lines.slice(0, 15)).toContain('tokens: 712345')
    expect(text).toContain(`${FACTS}\n\n${INSTRUCTIONS_HEADING}`)
    expect(text.indexOf('## 10. Assumptions to verify')).toBeLessThan(text.indexOf(FACTS_HEADING))
    expect(text).not.toContain('```')
    expect(text).not.toContain('Here is the brief.')
  })

  test('status answered gives mode wait and the wait instructions', () => {
    const sections = (extractSections(SECTIONS_TEXT, template()) as string).replace('Status: partial', 'Status: answered')
    const text = composeBrief(template(), HEADER, sections, FACTS) as string
    expect(verifyBrief(text, template())).toEqual({ ok: true, mode: 'wait' })
    expect(text).toContain(instructionsFor('wait', 'session-id')[1] as string)
  })

  test('the fresh-session instructions say verify first, the mode action, and the consent rule', () => {
    const c = instructionsFor('continue', 'session-id').join('\n')
    expect(c).toContain('verify the facts')
    expect(c).toContain('git, the files and the tickets')
    expect(c).toContain('unfinished user objective')
    expect(c).toContain('consent')
    expect(instructionsFor('wait', 'session-id').join('\n')).toContain('five lines')
  })

  test('a missing heading is rejected', () => {
    const text = goodBrief().replace('## 4. In flight\n', '')
    expect(verifyBrief(text, template())).toEqual({ failure: 'heading "## 4. In flight" must appear exactly once' })
  })

  test('headings out of order are rejected', () => {
    const text = goodBrief().replace('## 2. User decisions and constraints, verbatim, dated', '## X').replace('## 3. Pending, owned by the user', '## 2. User decisions and constraints, verbatim, dated').replace('## X', '## 3. Pending, owned by the user')
    expect(verifyBrief(text, template())).toEqual({ failure: 'heading "## 3. Pending, owned by the user" is out of order' })
  })

  test('a missing, doubled or bad Status line is rejected', () => {
    const t = template()
    expect(verifyBrief(goodBrief().replace('Status: partial\n', ''), t)).toEqual({ failure: 'section 8 lacks exactly one valid Status line' })
    expect(verifyBrief(goodBrief().replace('Status: partial', 'Status: partial\nStatus: answered'), t)).toEqual({ failure: 'section 8 lacks exactly one valid Status line' })
    expect(verifyBrief(goodBrief().replace('Status: partial', 'Status: mostly'), t)).toEqual({ failure: 'section 8 lacks exactly one valid Status line' })
    const sections = (extractSections(SECTIONS_TEXT, t) as string).replace('Status: partial', 'Status: done')
    expect(composeBrief(t, HEADER, sections, FACTS)).toEqual({ failure: 'section 8 lacks exactly one valid Status line' })
  })

  test('a Status line outside section 8 does not count', () => {
    const t = template()
    const moved = goodBrief().replace('Status: partial\n', '').replace('## 9. Dead ends\n', '## 9. Dead ends\nStatus: partial\n')
    expect(statusOf(moved, t)).toBeNull()
  })

  test('a short session id is rejected', () => {
    const text = goodBrief().replace(`session: ${SESSION}`, 'session: 22222222')
    expect(verifyBrief(text, template())).toEqual({ failure: 'session is not a full session id' })
  })

  test('a missing or empty header key is rejected; mode must match the status', () => {
    const t = template()
    expect(verifyBrief(goodBrief().replace(/^previous: .*$/m, ''), t)).toEqual({ failure: 'header key "previous" must appear once in the first 15 lines' })
    expect(verifyBrief(goodBrief().replace('tokens: 712345', 'tokens: lots'), t)).toEqual({ failure: 'tokens is not an integer' })
    expect(verifyBrief(goodBrief().replace('mode: continue', 'mode: wait'), t)).toEqual({ failure: 'mode does not match Status: partial' })
  })

  test('facts and instructions headings must follow section 10 in order', () => {
    const t = template()
    const noFacts = goodBrief().replace(`${FACTS_HEADING}\n`, '')
    expect(verifyBrief(noFacts, t)).toEqual({ failure: `heading "${FACTS_HEADING}" must appear exactly once` })
  })

  test('compose refuses an empty header value', () => {
    const sections = extractSections(SECTIONS_TEXT, template()) as string
    expect(composeBrief(template(), { ...HEADER, transcript: '' }, sections, FACTS)).toEqual({ failure: 'no value for header key(s) transcript' })
  })

  test('sections text without the first heading is refused', () => {
    expect(extractSections('no headings here', template())).toEqual({ failure: 'fork text lacks the heading "## 1. Active goal and role"' })
  })
})

describe('names and times (C3)', () => {
  test('file name is <full id>-<YYYYMMDD-HHMM>-<n>.md in local time', () => {
    const at = Date.UTC(2026, 9, 4, 19, 40, 5)
    const t = localTime(at, 180)
    expect(t).toEqual({ stamp: '20261004-2240', iso: '2026-10-04T22:40:05+03:00' })
    expect(briefFileName(SESSION, t.stamp, 1)).toBe(`${SESSION}-20261004-2240-1.md`)
    expect(localTime(at, -330).iso).toBe('2026-10-04T14:10:05-05:30')
  })

  test('isolation: two names in one minute differ by the cycle suffix; two sessions never share a name', () => {
    const OTHER = '33333333-aaaa-4bbb-8ccc-000000000003'
    expect(briefFileName(SESSION, '20261004-2240', 1)).not.toBe(briefFileName(SESSION, '20261004-2240', 2))
    expect(briefFileName(SESSION, '20261004-2240', 1)).not.toBe(briefFileName(OTHER, '20261004-2240', 1))
    expect(briefFileName(OTHER, '20261004-2240', 1).startsWith(`${OTHER}-`)).toBe(true)
  })

  test('date +%z output parses to minutes east of UTC', () => {
    expect(parseUtcOffset('+0300\n')).toBe(180)
    expect(parseUtcOffset('-0530')).toBe(-330)
    expect(parseUtcOffset('UTC')).toBeNull()
  })
})
