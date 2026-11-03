import { fixturePath } from '../fixtures/paths'

import { describe, expect, test } from 'bun:test'

import { HANDOFF_NOW_REFUSAL, gateHandoffNow, runEndedAnswer, runEndedFor } from '../../hooks/handoff-now'
import { rewriteCompactWarning } from '../../hooks/warning'

const typed = (promptText: string, turnText = promptText) => ({ turnId: 't', origin: 'composer' as const, promptText, turnText })

describe('handoff_now gating', () => {
  test('queues for a typed /compact-crafter or an explicit typed compaction request (any case)', () => {
    expect(gateHandoffNow(typed('/compact-crafter'), undefined, false)).toEqual({ queue: 'manual' })
    expect(gateHandoffNow(typed('please COMPACT now'), undefined, false)).toEqual({ queue: 'manual' })
  })

  test('the turn text alone never opens the gate', () => {
    expect(gateHandoffNow(typed('', 'skill text about compaction'), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
  })

  test('refuses a typed prompt without a compaction request', () => {
    expect(gateHandoffNow(typed('fix the tests'), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
  })

  test('queues when the typed prompt instructs the bare compact-crafter name', () => {
    for (const text of [
      'do the compact-crafter',
      'run compact-crafter now',
      'you do now the compact-crafter',
      'for TASK-42, you do now the compact-crafter just tell the assistant first',
    ]) {
      expect(gateHandoffNow(typed(text), undefined, false)).toEqual({ queue: 'manual' })
    }
  })

  test('a mention, a negation, a question, or a quote of compact-crafter stays shut', () => {
    for (const text of [
      'the compact-crafter skill is useful',
      "don't run compact-crafter",
      'do not run the compact-crafter',
      'what does compact-crafter do?',
      'fix the parser\n> do the compact-crafter',
      'see the log:\n```\ndo the compact-crafter\n```',
      'do the `compact-crafter` later',
    ]) {
      expect(gateHandoffNow(typed(text), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    }
  })

  test('the bare name before a noun or a path, or inside an instruction-shaped question, stays shut', () => {
    for (const text of [
      'run the compact-crafter tests',
      'run compact-crafter tests and fix failures',
      'do the compact-crafter fix from TASK-43',
      'start the compact-crafter refactor',
      'queue the compact-crafter ticket in Plane',
      'trigger compact-crafter-v2 build',
      'do a compact-crafter review of this diff',
      'run compact-crafter.ts through the linter',
      "run compact-crafter's unit tests",
      'do the compact-crafter/SKILL.md edit',
      'run the compact-crafter skill tests',
      'should I do the compact-crafter?',
    ]) {
      expect(gateHandoffNow(typed(text), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    }
  })

  test('the bare name still opens at a sentence end or before a word that continues the instruction', () => {
    for (const text of [
      'please run the compact-crafter skill',
      'Do the compact-crafter.',
      'do the compact-crafter, then tell codex',
      'run compact-crafter first and then report',
    ]) {
      expect(gateHandoffNow(typed(text), undefined, false)).toEqual({ queue: 'manual' })
    }
  })

  test('each word allowed after the bare name opens it, and so does a line break', () => {
    for (const text of [
      'do the compact-crafter right now',
      'do the compact-crafter now',
      'do the compact-crafter just tell codex',
      'do the compact-crafter then report',
      'do the compact-crafter first',
      'do the compact-crafter please',
      'do the compact-crafter pls',
      'do the compact-crafter asap',
      'do the compact-crafter again',
      'do the compact-crafter immediately',
      'do the compact-crafter thanks',
      'do the compact-crafter and tell codex',
      'do the compact-crafter\nCodex has the plan',
    ]) {
      expect(gateHandoffNow(typed(text), undefined, false)).toEqual({ queue: 'manual' })
    }
  })

  test('punctuation, a path, a lookalike or any other word after the bare name stays shut', () => {
    for (const text of [
      'do the compact-crafter ../SKILL.md edit',
      'run compact-crafter ./tests/pure',
      `run compact-crafter ${fixturePath('tmp/x.ts')}`,
      'run the compact-crafter (unit) tests',
      'run compact-crafter "tests"',
      'do the compact-crafter #173 fix',
      'do the compact-crafter @handoff-now.ts edit',
      'start the compact-crafter + track refactor',
      'run compact-crafter‑v2 build',
      'do a compact-crafter–style review',
      'run compact-crafter＇s unit tests',
      'run compact-crafter`s unit tests',
      'run compact-crafter\\SKILL.md',
      'run compact-crafter..ts',
      'run the compact-crafter​tests',
      'do the compact-crafter then-branch fix',
      'the mod should start compact-crafter when context hits 80%',
      'the timer will trigger compact-crafter after the 3rd warning',
      'add a test that we run compact-crafter once',
    ]) {
      expect(gateHandoffNow(typed(text), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    }
  })

  test('refuses a plugin seed, another origin, an unknown turn and a subagent', () => {
    expect(gateHandoffNow({ turnId: 't', origin: 'own-seed', promptText: 'compact', turnText: 'compact' }, undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    expect(gateHandoffNow({ turnId: 't', origin: 'other', promptText: '/compact-crafter', turnText: '' }, undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    expect(gateHandoffNow(null, undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    expect(gateHandoffNow(typed('/compact-crafter'), 'agent-1', false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
  })

  test('the refusal text is the contract text (one-path wording, W2b; the compact_now wording is gone)', () => {
    expect(HANDOFF_NOW_REFUSAL).toBe(
      'handoff_now refused: only a turn the user started with /compact-crafter (or a typed handoff request), or the ' +
        "mod's own automatic run, may hand off. Tell the user the snapshot path and stop.",
    )
  })
})

describe('item 12: the 65% warning rewrite', () => {
  test('rewrites only the CONTEXT COMPACT entry and keeps the percent', () => {
    const r = rewriteCompactWarning(['other note', 'CONTEXT COMPACT (66%): Context is high ... then run /compact ...'], 70)
    expect(r.isChanged).toBe(true)
    expect(r.entries?.[0]).toBe('other note')
    expect(r.entries?.[1]).toStartWith('CONTEXT HANDOFF (66%):')
    expect(r.entries?.[1]).toContain('70%')
    expect(r.entries?.[1]).not.toContain('then run /compact')
  })

  test('W2e r1: the text names the two stages, the nudge at the threshold and the run at the next clean turn end', () => {
    const text = rewriteCompactWarning(['CONTEXT COMPACT (66%): run /compact'], '400000 tokens').entries?.[0] ?? ''
    expect(text).toBe(
      'CONTEXT HANDOFF (66%): the context-handoff mod is active. At 400000 tokens it asks once for a natural ' +
        'checkpoint; at the next clean turn end after that it writes a full brief and moves this work to a fresh ' +
        'session. Finish the step in progress and end the turn normally; do not run /compact.',
    )
    expect(text).not.toContain('first turn end')
  })

  test('leaves other output alone', () => {
    expect(rewriteCompactWarning(['CONTEXT PREPARE (44%): ...'], 70)).toEqual({ entries: ['CONTEXT PREPARE (44%): ...'], isChanged: false })
    expect(rewriteCompactWarning(undefined, 70)).toEqual({ entries: undefined, isChanged: false })
  })
})

describe('review finding ch L11 (2026-10-20)', () => {
  test('a path that contains /compact-crafter does not open the composer door', () => {
    for (const prompt of [
      'Target: the compact-crafter skill at ~/.claude/skills/compact-crafter (tracked in the sample-project repo)',
      'read ~/.claude/skills/compact-crafter/SKILL.md and summarize it',
      'cd mods/context-handoff && run the tests under skills/compact-crafter/tests',
    ]) expect(gateHandoffNow(typed(prompt), undefined, false)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
  })

  test('the slash command still opens it at the start or after a space', () => {
    expect(gateHandoffNow(typed('/compact-crafter'), undefined, false)).toEqual({ queue: 'manual' })
    expect(gateHandoffNow(typed('ok, run /compact-crafter now'), undefined, false)).toEqual({ queue: 'manual' })
  })
})

describe('TRACK-25 U4: an ended automatic run answers with its real ending reason', () => {
  const TIMEOUT = { event: 'auto-run-timeout', seconds: 180 }
  const TIMEOUT_ANSWER = 'automatic run timed out after 180 s; stop and print one line'

  test('the run-ended answer comes before the composer check', () => {
    expect(gateHandoffNow(typed('/compact-crafter'), undefined, false, TIMEOUT)).toEqual({ refuse: TIMEOUT_ANSWER })
    expect(gateHandoffNow(typed('fix the tests'), undefined, false, TIMEOUT)).toEqual({ refuse: TIMEOUT_ANSWER })
    expect(gateHandoffNow({ turnId: 't2', origin: 'own-skill', promptText: '', turnText: '' }, undefined, true, TIMEOUT)).toEqual({ refuse: TIMEOUT_ANSWER })
  })

  test('no turn and a subagent still get the contract refusal', () => {
    expect(gateHandoffNow(null, undefined, false, TIMEOUT)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
    expect(gateHandoffNow(typed('/compact-crafter'), 'agent-1', false, TIMEOUT)).toEqual({ refuse: HANDOFF_NOW_REFUSAL })
  })

  test('the answer names the timeout in seconds, and any other ending by its event', () => {
    expect(runEndedAnswer(TIMEOUT)).toBe(TIMEOUT_ANSWER)
    expect(runEndedAnswer({ event: 'auto-run-failed', seconds: 180 })).toBe('automatic run ended (auto-run-failed); stop and print one line')
  })

  test('runEndedFor answers only for a turn of the run that ended, never for a later turn', () => {
    const end = { cycleId: 's#1', turnIds: ['t2', 't3'], event: 'auto-run-timeout', at: 5 }
    expect(runEndedFor(end, 't2', 180)).toEqual(TIMEOUT)
    expect(runEndedFor(end, 't3', 120)).toEqual({ event: 'auto-run-timeout', seconds: 120 })
    expect(runEndedFor(end, 't9', 180)).toBeUndefined()
    expect(runEndedFor(end, null, 180)).toBeUndefined()
    expect(runEndedFor(null, 't2', 180)).toBeUndefined()
  })
})
