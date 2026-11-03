import { fixturePath } from '../fixtures/paths'

// Shared by the machine specs: drive an armed cycle through the automatic run (W2b Phase 1), the
// way the live engine orders it: auto-run-called, the own prompt.submit, the own-skill turn.start
// with the command markup, handoff_now's brief from that turn, then that turn's end.
import type { HandoffConfig } from '../../hooks/config'
import { AUTO_RUN_MARKUP, step } from '../../hooks/machine'
import type { MachineEvent, MachineState, MarkerSnapshot } from '../../hooks/machine'

export const RUN_TURN = 'run-turn'

function apply(state: MachineState, events: MachineEvent[], config: HandoffConfig): MachineState {
  return events.reduce((s, e) => step(s, e, config).state, state)
}

/** BRIEFING with the run bound to RUN_TURN and its brief queued (the old VERIFYING's place). */
export function runQueued(briefing: MachineState, config: HandoffConfig, now: number, path = fixturePath('tmp/briefs/x.md'), markers: MarkerSnapshot | null = null): MachineState {
  const cycleId = briefing.cycleId as string
  return apply(briefing, [
    { type: 'autoRunCalled', cycleId, now: now + 1 },
    { type: 'autoRunSubmit', cycleId, now: now + 2 },
    { type: 'turnStart', now: now + 3, origin: 'own-skill', turnId: RUN_TURN, text: `${AUTO_RUN_MARKUP}\n<command-args>automatic-run cycle=${cycleId} session=${briefing.sessionId}</command-args>` },
    { type: 'manualBrief', now: now + 4, path, turnId: RUN_TURN, markers },
  ], config)
}

/** GRACE after the run's turn ended with the queued brief. */
export function runToGrace(briefing: MachineState, config: HandoffConfig, now: number, path = fixturePath('tmp/briefs/x.md'), markers: MarkerSnapshot | null = null): MachineState {
  const queued = runQueued(briefing, config, now, path, markers)
  return step(queued, {
    type: 'turnEnd', now: now + 10, sessionId: queued.sessionId, turnId: RUN_TURN, reason: 'answer',
    percent: 75, tokens: 750_000, draft: '', isKillSwitchOn: false, openReviews: 0, answer: 'done',
  }, config).state
}
