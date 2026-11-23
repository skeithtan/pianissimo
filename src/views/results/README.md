# views/results — the scorecard and history panels

Spec: "Results and timing", "Repeating passages" (pass condition, streaks). The panels and their data, shown
by Progress (`views/progress`) and by the practice result card (`views/practice/ResultDetails.tsx`). There is
no Results page (U148); both callers are lazy chunks.

| File | Content |
| --- | --- |
| `ScorecardPanel.tsx` | One attempt: completion (with the interruption reason), pass line, wrong-note attacks (+ "N of them too early" when the record carries it), first-pass groups, completion time, expected time, time difference (actual minus expected, seconds and %), full notated duration, practice streak. "How completion time is measured" holds the spec definition. |
| `HistoryPanel.tsx` | Same comparison context only: best clean card (closest to expected, H5) and streak; clean (ranked), not clean (wrong notes or, in Keep time, missed groups) and incomplete attempts (diagnostics only). Every row opens that attempt's scorecard. |
| `data.ts` | `loadResultsData(storage, { pieceId, attemptId? })`: flushes the `HistoryWriter` first, then reads the piece, its attempts for the shown score version, and the package's occurrences for bar labels. |
| `model.ts` | Pure: `deriveResults` (an attempt, its scorecard with the streak as of then, its context's history), `passGroups` (the scored attempts by context, the most recent first), `passageText`, `passReason`. |
| `format.ts` | Display text: when, speed, hands, mode, a pass in a few words. |

Help is not told apart anywhere (U144, U148). A strict (Keep time) context reads "Keep time · ±150 ms"; its
scorecard replaces the completion time tiles with the timing rows (on-time, early, late, missed groups,
average offset, timing window; neutral, no coloring), and its best clean pass has the smallest average offset.

## Decisions

RV1–RV8. In short: comparison is by `contextKey` only; timing is neutral; an incomplete attempt never shows a
completion time or a tempo comparison, even if its record holds a time; single-group passages show an ungraded
"Time to solve"; ordinary-reading attempts are never compared.

## Tests

`model.test.ts`, `passage.test.ts`, `panels.test.tsx`, `tokens.test.ts` (no literal colors). Run
`npx vitest run src/views/results`.
