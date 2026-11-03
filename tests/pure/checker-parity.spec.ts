// Review findings cc M7, M8 (2026-10-20): the mod's side of the checker-parity corpus in
// skills/compact-crafter/tests/test_checker_parity.py.
import { expect, test } from 'bun:test'
import { pendingItems } from '../../hooks/pending-items'

const item = { track_id: 'plan:76', subject: 'Memory decision', note: 'Owner: User', unblock: 'yes, save that memory' }
const section = (line: string) => `## 3. Pending, owned by the user\n${line}\n\n## 4. In flight\n- none`

test('a repeated JSON key is refused instead of keeping only its last value', () => {
  const record = JSON.stringify(item).slice(0, -1) + ',"note":"a second, different note"}'
  const result = pendingItems(section(`- Pending: ${record}`))
  expect(result).toHaveProperty('failure')
  expect((result as { failure: string }).failure).toContain('repeated key')
})

test('the key error names the optional status key', () => {
  const result = pendingItems(section(`- Pending: ${JSON.stringify({ ...item, status: 'paused', extra: 'x' })}`))
  expect((result as { failure: string }).failure).toContain('optionally status')
})
