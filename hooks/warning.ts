// Item 12: while the mod is active, the 65% "run /compact" warning that
// ~/.claude/hooks/context-monitor-warn.sh emits as PostToolUse
// additionalContext is rewritten to say a handoff runs at turn end. Pure.

export const COMPACT_WARNING_PREFIX = 'CONTEXT COMPACT ('

/** Rewrites every entry that starts with the warning prefix; the rest pass unchanged. */
export function rewriteCompactWarning(
  entries: readonly string[] | undefined,
  threshold: number | string,
): { entries: string[] | undefined; isChanged: boolean } {
  // A number is the percent trigger; a string names the trigger as is ("400000 tokens").
  const at = typeof threshold === 'number' ? `${threshold}%` : threshold
  if (entries === undefined) return { entries: undefined, isChanged: false }
  let isChanged = false
  const out = entries.map(entry => {
    if (!entry.startsWith(COMPACT_WARNING_PREFIX)) return entry
    isChanged = true
    const pct = /^CONTEXT COMPACT \((\d+)%\)/.exec(entry)?.[1] ?? '?'
    return (
      `CONTEXT HANDOFF (${pct}%): the context-handoff mod is active. At ${at} it asks once for a natural ` +
      'checkpoint; at the next clean turn end after that it writes a full brief and moves this work to a fresh ' +
      'session. Finish the step in progress and end the turn normally; do not run /compact.'
    )
  })
  return { entries: out, isChanged }
}
