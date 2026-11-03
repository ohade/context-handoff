# Compaction snapshot template

This file is the single source for the snapshot layout. `/compact-crafter` snapshots and the
`context-handoff` mod's briefs both follow it, and `scripts/check-snapshot.py` reads the header keys
and headings from it. Parsing rules (contract C2): header keys are the lines matching
`^([a-z]+): ` between the two header marker lines; required headings are the lines matching
`^## \d+\. .+$`, in file order; section 8 holds exactly one `Status:` line.

Copy everything from the header block down. Replace each `<...>` value, and replace each italic
guidance line with the content it asks for. Keep every section short. Use only facts verified in
this turn or quoted from the user; label anything else INFERENCE.

<!-- header -->
session: <full session id, never the 8-character short form>
previous: <session value of the brief this session was seeded from, or none>
transcript: <absolute path of this session's JSONL transcript>
created: <local time, ISO 8601 with offset, for example 2026-10-04T22:40:00+03:00>
<!-- /header -->

## 1. Active goal and role
*The unfinished user objective in their words, citing its actual user-message UUID or transcript record reference; later steering with its own references; what you own versus what others own. A status question does not replace unfinished work. Track rows do not choose the objective or grant authority.*

## 2. User decisions and constraints, verbatim, dated
*Quote them; never paraphrase a rule.*

## 3. Pending, owned by the user
*Use one `- Pending: <JSON record>` line per declared item, or `- none`. Each record has `track_id` (real tool id, or null when Track is absent), `subject` (exact row title), `note` (full exact owner/blocker note, including hashes for staged protected-file changes), and `unblock` (exact reply phrase). Include `status` (`paused` or `waiting`) matching the saved row; legacy records without it mean waiting. No other keys are allowed. Keep separate decisions in separate records; records grant no execution consent. Register or repair rows only outside an automatic run, preserving existing plan rows with track_steps after.*

## 4. In flight
*Agents and background tasks: IDs, what each is doing, and how its completion will arrive. Include the restart rule for any watcher or poller.*

## 5. Identifiers the next context must type
*Paths, URLs, commit SHAs, kit, job or review IDs, thread names.*

## 6. Last outgoing instruction
*What was sent to whom, and what reply is expected.*

## 7. Do not redo
*Settled questions and rejected approaches, one line each.*

## 8. Last request and status
*The unfinished objective and later user steering, with references to the actual user messages. Include the latest request separately. Then exactly one line `Status: answered`, `Status: partial` or `Status: not answered` for the unfinished objective, followed by what remains. Answering a status question does not make the objective answered.*

## 9. Dead ends
*What was tried and failed, one line each, with the reason it failed.*

## 10. Assumptions to verify
*Beliefs the next context must check before acting on them, one line each, with the check to run.*
