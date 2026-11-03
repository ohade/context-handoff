// FIXTURE: synthetic Track responses include a status line and a Saved row JSON tail.
// The parser accepts matching receipts and refuses contradictory or extra content.
import { expect, test } from 'bun:test'
import { isMarked } from '../../hooks/preparation'

const SUBJECT = 'context-handoff: prepare snapshot manual-11111111-aaaa-4bbb-8ccc-000000000001-1'
const head = (id: string, status: string) => `Step ${id} "${SUBJECT}" marked ${status}.`
const saved = (id: string, status: string, note?: string) => `Saved row: ${JSON.stringify({ id, subject: SUBJECT, status, ...(note !== undefined && { note }) })}`
const response = (id: string, status: string, note?: string) => `${head(id, status)}\n${saved(id, status, note)}`
const NOTE = 'context-handoff: handoff cycle manual-11111111-1 was cancelled before its snapshot was queued; the handoff did not run.'

test('the completed answer with its Saved row tail is accepted', () => {
  expect(isMarked(response('plan:3', 'completed'), 'plan:3', 'completed')).toBe(true)
})

test('the paused answer with its Saved row tail (and note) is accepted', () => {
  expect(isMarked(response('plan:3', 'paused', NOTE), 'plan:3', 'paused')).toBe(true)
})

test('the bare answer without a Saved row tail is still accepted, for both statuses', () => {
  expect(isMarked(head('plan:3', 'completed'), 'plan:3', 'completed')).toBe(true)
  expect(isMarked(head('plan:3', 'paused'), 'plan:3', 'paused')).toBe(true)
})

test('an answer for another status is refused, with and without the tail', () => {
  expect(isMarked(response('plan:3', 'paused', NOTE), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(head('plan:3', 'paused'), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(response('plan:3', 'completed'), 'plan:3', 'paused')).toBe(false)
  expect(isMarked(head('plan:3', 'completed'), 'plan:3', 'paused')).toBe(false)
})

test('an answer for another step id is refused, with and without the tail', () => {
  expect(isMarked(response('plan:4', 'completed'), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(head('plan:4', 'completed'), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(response('plan:30', 'paused', NOTE), 'plan:3', 'paused')).toBe(false)
})

test('Track\'s no-change answer and an unrecognised tail are refused', () => {
  expect(isMarked('No change. Known steps: plan:1 (completed), plan:2 (pending).', 'plan:3', 'completed')).toBe(false)
  expect(isMarked(`${head('plan:3', 'completed')}\nsomething else`, 'plan:3', 'completed')).toBe(false)
})

test('malformed, contradictory, or extra Saved row content is refused', () => {
  const answer = (row: string) => `${head('plan:3', 'completed')}\nSaved row: ${row}`
  expect(isMarked(answer(''), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer('not-json'), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer('{}'), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer(`${JSON.stringify({ id: 'plan:3', subject: SUBJECT, status: 'completed' })} extra`), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer(JSON.stringify({ id: 'plan:4', subject: SUBJECT, status: 'completed' })), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer(JSON.stringify({ id: 'plan:3', subject: SUBJECT, status: 'paused' })), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer(JSON.stringify({ id: 'plan:3', subject: 'different subject', status: 'completed' })), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(answer(JSON.stringify({ id: 'plan:3', subject: null, status: 'completed' })), 'plan:3', 'completed')).toBe(false)
  expect(isMarked(`${answer(JSON.stringify({ id: 'plan:3', subject: SUBJECT, status: 'completed' }))}\nextra`, 'plan:3', 'completed')).toBe(false)
})
