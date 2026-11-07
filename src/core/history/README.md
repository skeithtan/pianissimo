# core/history

Measure histories, suggested practice and result summaries. Pure TypeScript: no DOM, no
storage, no clocks (callers pass timestamps), worker-safe. Consumes `AttemptRecord`,
`MeasureTraversal` and `AbandonEvent` exactly as `core/model/practice.ts` defines them (the
engine produces them); persistence lives in `core/storage` (`HistoryWriter`).

Spec: "Suggested practice" (all subsections), "Results and timing" (scorecard, streak, best
clean unassisted versus assisted), the assistance paragraph of "Persistent score labels".

## Public API (`index.ts`)

| Area | Entry points |
| --- | --- |
| Ingest | `ingestAttempt(history, attempt, now)`, `ingestAbandon(history, event, now)` → `{ history, changes }` |
| State | `PieceHistory`, `BarRecord`, `SuggestionRecord`, `emptyPieceHistory(pieceId)`, `barKey(measureContextKey, occ)` |
| Detection | `barEvidence`, `meetsFlagRule`, `compareEvidence`, constants in `types.ts` (`RECENT_TRAVERSALS`, `FLAG_*`, `RECOVERY_STREAK`, `ABANDON_*`, `MAX_SUGGESTIONS`, `MAX_PASSAGE_BARS`, `CONTEXT_BARS`) |
| Choosing | `selectSuggestions(history, occurrences, { scoreVersionId, enabled, dismissed?, max? })` → `{ active, improved, disabled }` of display-ready `Suggestion`s |
| Passages | `adjacentRuns`, `chunkRun`, `withContextBars`, `MAX_CORE_BARS` |
| Controls | `SessionDismissals` (in-memory), `setSuggestionsDisabled`, `clearPracticeHistory` |
| Results | `summarizeContext`, `summarizeByContext` → `ContextResults` (best clean, assisted, incomplete, streak), `practiceStreak`, `compareCleanRuns`, `isAssistedAttempt`, `isCleanUnassistedCompletion`, `timeDifferenceSec`, `timingAccuracy` (strict records: groups, onTime, early, late, missed, mean and mean absolute offset) |
| Scorecard | `buildScorecard(attempt, streak?)` → typed values plus formatted `rows`; `COMPLETION_TIME_DEFINITION`, `formatSeconds` |
| Labels | `createBarLabeler(occurrences)` ("12", "12 (pass 2)", "bars 12–14") |

`ingest*` are pure and return `changes` (bars, whether suggestions changed, abandon keys) so
storage writes only what moved. The same attempt ingested twice is a no-op.

## How it works

Keys. A bar's history is keyed by `(measure context, occurrence)`; the measure context is the
comparison context without the passage (`measureContextKey`): score version, hands, tempo map,
speed, roll policy, transport, matching rules. A repeat pass is its own occurrence. Practice at
another tempo, speed or hand selection therefore has separate histories and separate
suggestions, and never advances or erases the original one.

Per bar: the five most recent **complete** traversals (`recent`) and a `cleanStreak`. Each
traversal is reduced to `errorBearing` (any wrong attack **excluding loop-boundary reattacks**,
`wrongAttacksExcludingBoundary`) and `assisted` (temporary hint, persistent label including
read-ahead exposure, or keyboard guide, as attributed by the engine to that measure).

Flagging (proposed default). At least 3 complete traversals, at least 3 error-bearing, and at
least 60% of the available ones error-bearing. Each traversal counts once however many wrong
keys it had. Assisted error-free traversals count as available (they dilute) but are not
error-bearing. Partial traversals never enter the window.

Suggestions. Newly flagged bars merge with adjacent flagged bars in the same context into a run;
a run longer than 6 bars is split as evenly as possible (7 becomes 4 + 3) so that, with one
context bar before and after (where the score has them), a passage never exceeds 8 bars.
Context bars are reported with `role: 'context'`, difficult bars with `role: 'difficult'`.

Recovery. A suggestion stays active until every flagged bar has `RECOVERY_STREAK` (3)
consecutive complete, clean, unassisted traversals in the same context. An error-bearing or
assisted complete traversal resets the streak; a partial traversal never advances it and
breaks it when a mistake or assistance was observed in it (a partial pass with neither leaves
it alone). Falling below the detection threshold alone never resolves a suggestion. Resolved
suggestions move to `improved` (newest first, ten kept per piece) and the bars can flag again.
Context bars need not be mastered.

Repeated restarts. Three `user-stop`/`user-restart` events at one bar create a separately
labeled `restart` suggestion. Every other reason (pause, seek, disconnect, suspend, setting,
layout, tempo, hand, range or mode change) is ignored. Restart suggestions never touch the
percentages, follow traversal-backed ones in the list, are hidden while a traversal suggestion
covers all their bars, and recover the same way (3 clean complete traversals).

Ranking. Traversal-backed: recent proportion of error passes, then evidence count, then
recency of the latest mistake, taken from the worst bar of a merged run. The window only
holds five passes, so lifetime totals cannot influence it. Restart: number of events, then
recency. At most three are shown; session-dismissed ones are skipped before cutting to three.

Results. Comparison is by `contextKey`; ordinary reading and Preview never appear. The best
clean unassisted run is the one whose completion time is closest to the expected time
(absolute difference; a faster time is not automatically better). Assisted runs, runs with
wrong attacks and incomplete attempts are listed separately and never ranked.

## Decisions and interpretations

- Preview (hands `none`) attempts are ignored: the spec records no result for it.
- A suggestion keeps its id while its range is unchanged, so a session dismissal sticks;
  growing or splitting a cluster creates new ids.
- Restart evidence is cleared for a bar when a suggestion covering it improves.
- Practice streak: only completed scored attempts extend it. Pauses, disconnects, suspension,
  seeks and setting changes are neutral (the spec says they record no failed or successful
  performance); a user stop or restart **after wrong attacks** ends the run, because it is a
  failed pass the player chose to abandon.
- Merged suggestions rank by their worst bar rather than an average, so one bad bar is not
  diluted by its neighbors.

## Spec coverage

Done and tested (`*.test.ts`): rolling window and flag rule (including the 3-of-5 and
one-bad-pass cases), unvisited and partial bars, boundary-reattack exclusion, recovery (clean,
assisted/label/keyboard, other tempo/hand/version, partial, merged runs, below-threshold),
Improved list and re-flagging, repeated-restart trigger and exclusions, ranking, three-at-a-time,
splitting to eight bars, context bars, dismiss / disable / clear, best clean versus assisted,
streaks, scorecard rows.

Left: the notation preview of a suggestion (renderer), the Practice-this-passage button and
boundary adjustment (views open the repeat workflow with `Suggestion.passage`, `hands`,
`multiplier`), and the engine wiring (`app/session` queues the engine's records into
`HistoryWriter`).

## Rhythm mode (strict transport) results

A clean unassisted completion also needs `missedGroups` 0 (absent = 0) in every context. For two
strict records `compareCleanRuns` ranks by `timingAccuracy(...).meanAbsOffsetMs` (fewest first,
then most recent): the music set the pace, so there is no expected total time. Early and late mean
beyond `rhythm.toleranceMs`. `buildScorecard` gives a completed strict record `timing: 'rhythm'`
and the rows on-time groups ("38 of 42 (90%)"), early, late, missed, average offset (signed ms,
"dragging" / "rushing" beyond a third of the tolerance) and the timing window; it has no
completion time, expected time or difference rows, and an incomplete strict attempt shows no timing.
