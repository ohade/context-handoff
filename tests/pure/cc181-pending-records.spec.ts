import { fixturePath } from '../fixtures/paths'

// FIXTURE: CC-181 (2026-10-10). Declared items and public checkpoint rows must
// be well-formed before their references can certify coverage at clear time.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { checkSnapshot, composeBrief, parseTemplate } from '../../hooks/brief'
import { checkpointOf } from '../../hooks/track-contract'

const source = '11111111-aaaa-4bbb-8ccc-000000000001'
const template = parseTemplate(readFileSync(new URL('../fixtures/template.md', import.meta.url), 'utf8'))
if ('failure' in template) throw new Error(template.failure)
const sections = readFileSync(new URL('../fixtures/sections.md', import.meta.url), 'utf8')
const item = { track_id: 'plan:76', subject: 'Retention decision', note: 'Owner: User', unblock: 'yes, save that memory' }
const row = { id: 'plan:76', subject: item.subject, status: 'waiting', note: item.note }
const receipt = { v: 1, ok: true, source_session: source, revision: 1, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: 1 } }
const header = { session: source, previous: 'none', transcript: fixturePath('t.jsonl'), created: '2026-10-10T16:10:00+03:00', tokens: 75 }
const body = (line: string) => sections.replace('## 3. Pending, owned by the user\n- none', `## 3. Pending, owned by the user\n${line}`)
const snapshot = (line: string) => `<!-- header -->\nsession: ${source}\nprevious: none\ntranscript: ${fixturePath('t.jsonl')}\ncreated: 2026-10-10T16:10:00+03:00\n<!-- /header -->\n${body(line)}`

test('unstructured combined decisions and malformed or duplicate records fail snapshot checking', () => {
  for (const line of [
    '- Release decision and Performance decision', '- Pending: {invalid',
    `- Pending: ${JSON.stringify({ ...item, unblock: '' })}`,
    `- Pending: ${JSON.stringify({ ...item, track_id: 'S76' })}`,
    `- Pending: ${JSON.stringify({ ...item, other: 'another item' })}`,
    [`- Pending: ${JSON.stringify(item)}`, `- Pending: ${JSON.stringify(item)}`].join('\n'),
  ]) expect(checkSnapshot(snapshot(line), template)).toHaveProperty('failure')
})

test('brief renders canonical records rather than carrying independent pending prose', () => {
  const noncanonical = '- Pending: { "unblock": "yes, save that memory", "note": "Owner: User", "subject": "Retention decision", "track_id": "plan:76" }'
  const brief = composeBrief(template, header, body(noncanonical), `## Facts from the transcript\nSource: ${fixturePath('t.jsonl')}`)
  expect(typeof brief).toBe('string')
  expect(brief).toContain(`- Pending: ${JSON.stringify(item)}`)
  expect(brief).not.toContain(noncanonical)
})

test('a public checkpoint inventory rejects invalid, cleared, completed, duplicate and over-counted rows', () => {
  for (const open_steps of [null, {}, [row, row], [{ ...row, status: 'completed' }], [{ ...row, cleared: true }], [{ ...row, id: 76 }], [{ ...row, note: null }], [row, { ...row, id: 'plan:77' }]]) {
    expect(checkpointOf({ result: JSON.stringify({ ...receipt, open_steps }) }, source)).toHaveProperty('failure')
  }
  expect(checkpointOf({ result: JSON.stringify({ ...receipt, open_steps: [row] }) }, source)).toEqual({ checkpoint: { ...receipt, open_steps: [row] } })
  // Old receipts still work when there are no declared pending items to certify.
  expect(checkpointOf({ result: JSON.stringify(receipt) }, source)).toEqual({ checkpoint: receipt })
})

test('an invented level-2 heading or a record outside section 3 cannot hide pending items', () => {
  // Review finding cc M1 (2026-10-20): '- none' then '## Deferred' then a record passed with items=[].
  const record = `- Pending: ${JSON.stringify(item)}`
  for (const text of [
    snapshot(`- none\n\n## Deferred\n${record}`),
    snapshot('- none\n\n## Deferred\n- User still has to decide the release date.'),
    snapshot('- none').replace('## 5. ', `${record}\n\n## 5. `),
  ]) expect(checkSnapshot(text, template)).toHaveProperty('failure')
})
