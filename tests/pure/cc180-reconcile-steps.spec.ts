// FIXTURE: CC-180, 2026-10-10. A fresh session restored steps but had no instruction
// to reconcile their status before starting the remaining user objective.
import { expect, test } from 'bun:test'
import { instructionsFor } from '../../hooks/brief'

for (const mode of ['continue', 'wait'] as const) {
  test(`the ${mode} brief reconciles each restored open step through Track before other work`, () => {
    const lines = instructionsFor(mode, '11111111-2222-4333-8444-555555555555')
    const reconcile = lines.findIndex(line => line.includes('Reconcile each restored open step'))
    const continuation = lines.findIndex(line => line.startsWith('4.'))
    expect(reconcile).toBeGreaterThanOrEqual(0)
    expect(reconcile).toBeLessThan(continuation)
    const instruction = lines[reconcile]!
    for (const phrase of ['mcp__track__mark_step', 'completed', 'cancelled', 'paused', 'cancellation note', 'superseded', 'new row', 'kept', 'owner or blocker', 'Track tools', 'never scrape']) {
      expect(instruction).toContain(phrase)
    }
    if (mode === 'continue') expect(lines.join('\n')).toContain('Track rows do not choose the objective')
  })
}
