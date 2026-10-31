# views/results — Passage Results

Spec: "Results and timing", "Repeating passages" (pass condition, streaks), "Suggested practice",
"Persistent score labels" (assistance paragraph). Lazily loaded from `app/views.ts`
(`ResultsView`). Opened with `openResults({ pieceId, attemptId? })` (`app/navigation.ts`):
`attemptId` omitted means the most recent stored attempt; with no request at all the view shows
an empty state linking to the Library.

## Layout

One column on phones and iPad portrait, two columns from 960 px (scorecard + suggestions left,
history + other settings right).

| Part | File | Content |
| --- | --- | --- |
| Context bar | `ResultsView.tsx` | The shown attempt's passage ("Bars 12–16"), hands and speed, "Piano plays the left hand" when accompanied; **Practice again** (`openPractice` with passage, hands and speed preselected, never starts) and **Back to latest**. |
| Scorecard | `ScorecardPanel.tsx` | Completion (with the interruption reason), pass line ("Pass: completed with no wrong notes and no assistance" or why not), wrong-note attacks (+ "N of them too early" when the record carries it), first-pass groups, completion time, expected time, time difference (actual minus expected, seconds and %), full notated duration, practice streak, and **assistance** as three separate lines: persistent score labels (setting, notes/groups revealed, rules recorded with the attempt), temporary hints (requests, automatic, groups revealed) and the keyboard guide. "How completion time is measured" holds the spec definition. |
| History | `HistoryPanel.tsx` | Same comparison context only. Best clean unassisted card (closest to expected, H5) and streak; groups: clean and unassisted (ranked), unassisted with wrong notes, assisted practice (never ranked), incomplete attempts (diagnostics only). Every row opens that attempt's scorecard. |
| Other settings | `ResultsView.tsx` | Other comparison contexts of the same score version, each with attempts, best clean time and **View latest**. They are never merged. |
| Suggested practice | `views/shared/suggestions` | The shared list (see its README) wired to `openPractice`, session dismissals and the per-piece switch. |

## Data flow

`ResultsView` (reads `resultsRequest`) → `loadResultsData(storage, request, sessionDismissals)`
(`data.ts`: flushes the `HistoryWriter` first, then `getPiece`, the piece's attempts for the
shown score version, the package's occurrences for bar labels, and `loadSuggestions`) →
`ResultsPage` (presentation) → `deriveResults` (`model.ts`, pure): picks the attempt, builds
`buildScorecard(attempt, streakAsOfThen)`, `summarizeByContext` for the context history and the
other contexts. The page keeps the selected attempt in the loader; nothing else is stored.

## Decisions

See DECISIONS RV1–RV9 in the hand-off report; in short:

- Comparison is by `contextKey` only; the history never lists another context's attempts.
- Timing is shown neutrally (no good/bad coloring): the best clean run is the one closest to the
  expected time, and the text says faster is not automatically better.
- An incomplete attempt never shows a completion time or a tempo comparison, even if its record
  holds a time (`ScorecardPanel` guards it).
- Single-group passages show errors, assistance and an ungraded "Time to solve", with no expected
  time or difference.
- Ordinary-reading attempts (only stored when `keepReadingAttempts` is set) can be viewed but are
  not compared.
- An attempt of an earlier score version can be viewed (its bar labels fall back to the bar index
  once its package is gone) but not practiced again from here.

## Known gaps

- **"Too early" breakdown** comes from `AttemptRecord.earlyAttacks` (engine-counted, RV4);
  records written before it existed show the total only.
- No notation preview in suggestion cards (needs a cached `PreparedLayout`).
- The shell app bar overflows at 360 px (Settings sits beyond the edge); it is not part of this
  view (see WP12 polish).

## Tests

`model.test.ts` (context separation, best clean versus assisted versus incomplete, streak as of
an attempt, single group, reading, pass reasons), `ResultsPage.test.tsx` (scorecard rows,
assistance lines, history filtering, selection, other contexts, actions, suggestions wiring, label
rules), `ResultsView.test.tsx` (real storage on fake-indexeddb: flush before read, requested
attempt, Practice again and Practice this passage presets, dismiss / disable / enable, global
switch, empty and missing states), `tokens.test.ts` (no literal colors). Run
`npx vitest run src/views/results`.
