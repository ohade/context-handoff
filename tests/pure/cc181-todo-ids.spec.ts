import { fixturePath } from '../fixtures/paths'

// FIXTURE: Astra found that Track's normalized TodoWrite IDs retain spaces.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { checkSnapshot, parseTemplate } from '../../hooks/brief'
import { checkpointOf } from '../../hooks/track-contract'

test('multiword TodoWrite IDs remain valid in inventories and pending records', () => {
  const source = '11111111-aaaa-4bbb-8ccc-000000000001'
  const row = { id: 'todo:review patch', status: 'waiting', subject: 'Review patch', note: 'Owner: User' }
  const receipt = { v: 1, ok: true, source_session: source, revision: 1, checksum: 'a'.repeat(64), counts: { questions: 0, answers: 0, steps: 1 }, open_steps: [row] }
  expect(checkpointOf({ result: JSON.stringify(receipt) }, source)).toEqual({ checkpoint: receipt })
  const template = parseTemplate(readFileSync(new URL('../fixtures/template.md', import.meta.url), 'utf8'))
  if ('failure' in template) throw new Error(template.failure)
  const sections = readFileSync(new URL('../fixtures/sections.md', import.meta.url), 'utf8').replace('## 3. Pending, owned by the user\n- none', `## 3. Pending, owned by the user\n- Pending: ${JSON.stringify({ track_id: row.id, subject: row.subject, note: row.note, unblock: 'Approve the patch' })}`)
  const snapshot = `<!-- header -->\nsession: ${source}\nprevious: none\ntranscript: ${fixturePath('t.jsonl')}\ncreated: 2026-10-10T16:10:00+03:00\n<!-- /header -->\n${sections}`
  expect(checkSnapshot(snapshot, template)).not.toHaveProperty('failure')
})
