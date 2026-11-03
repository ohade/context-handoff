// FIXTURE: the 2026-11-02 native seed rewrote an unchanged paused blocker note.
// This checks the generated instruction contract; fresh native acceptance is separate.
import { expect, test } from 'bun:test'
import { instructionsFor } from '../../hooks/brief'

for (const mode of ['continue', 'wait'] as const) {
  test(`${mode} reconciliation preserves verified unchanged rows`, () => {
    const text = instructionsFor(mode, 'source-session').join('\n')
    expect(text).toContain('Reconcile each restored open step')
    expect(text).toContain('complete open_steps inventory')
    expect(text).toContain('actual user messages and work evidence')
    expect(text).toContain('keep its exact subject, status and full note')
    expect(text).toContain('do not call `mcp__track__mark_step` just to restate it')
    expect(text).not.toContain('call `mcp__track__mark_step` for each:')
    for (const phrase of ['completed when verified finished', 'cancellation note', 'superseded', 'new row', 'never scrape']) {
      expect(text).toContain(phrase)
    }
  })
}
