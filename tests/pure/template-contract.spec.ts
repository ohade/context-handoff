// Reads the REAL template through the mod-relative path the mod uses
// (<mod>/../../skills/compact-crafter/reference/snapshot-template.md) and
// checks the C2 contract: ten headings in order and the four header keys.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseTemplate } from '../../hooks/brief'

const MOD_DIR = join(import.meta.dir, '..', '..')
const TEMPLATE_PATH = join(MOD_DIR, 'skills', 'compact-crafter', 'reference', 'snapshot-template.md')

describe('the real snapshot template (C2)', () => {
  test('has the four header keys and the ten headings, in order', () => {
    const parsed = parseTemplate(readFileSync(TEMPLATE_PATH, 'utf8'))
    if ('failure' in parsed) throw new Error(parsed.failure)
    expect(parsed.headerKeys).toEqual(['session', 'previous', 'transcript', 'created'])
    expect(parsed.headings).toEqual([
      '## 1. Active goal and role',
      '## 2. User decisions and constraints, verbatim, dated',
      '## 3. Pending, owned by the user',
      '## 4. In flight',
      '## 5. Identifiers the next context must type',
      '## 6. Last outgoing instruction',
      '## 7. Do not redo',
      '## 8. Last request and status',
      '## 9. Dead ends',
      '## 10. Assumptions to verify',
    ])
    expect(parsed.guidance.every(g => g.length > 0)).toBe(true)
  })
})
