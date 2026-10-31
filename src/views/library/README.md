# views/library — Library and Import

Spec: "Main user journey" 1–2, "MusicXML score import", "Storage and recovery", "Suggested
practice" (Library section), acceptance rows Supported file formats, MusicXML import validation,
MusicXML timing, Import mapping, Deferred assets, Import memory lifecycle.

The first screen, **bundled** with the shell (`app/views.ts`: `component: LibraryView`). It
imports neither the notation engine nor the piano samples; the importer runs in its worker
(`core/import/client`), and the backup zip code is a lazy chunk inside storage. Library modules
import `core/import/{client,hands,rolls,summary,limits,errors}` directly, never the
`core/import` index (which would pull the XML reader into the initial bundle).

## Layout

- **Header**: "Library", piece count, Import MusicXML (shown in the empty state instead when
  there are no pieces).
- **Empty state**: what to import (.musicxml / .mxl / MusicXML .xml), where it comes from, and a
  pointer to Restore.
- **Piece cards** (`PieceCard.tsx`): title, composer, "Opened 2 days ago", "75% speed", the
  user-entered tempo if any, **Practice** (→ `openPractice({ pieceId })`, after marking the piece
  opened). A disclosure "Suggested practice and options" (the most recently opened piece starts
  expanded) holds the suggestions and Review hands and tempo… / Replace score… / Clear practice
  history… / Delete…
- **Backup and restore** (`BackupPanel.tsx`) with the storage status line (persistence +
  usage of quota).
- **Import sheet** (`ImportSheet.tsx`, modal): progress + Cancel, score / part choice, summary,
  or a readable failure with "Choose another file". Add to library closes the sheet at once,
  shows a notice, and opens Practice with a one-time automatic start request. Replace score
  stays in the Library. The storage status line lives in the backup panel.

## Files

| File | Role |
| --- | --- |
| `LibraryView.tsx` | Registered view (`LibraryView`) and the injectable `Library({ deps })`. |
| `deps.ts` | `LibraryDeps` (storage, import client factory, `navigator.storage`, clock, download, settings flush/reload, iPad detection) + context. |
| `libraryModel.ts` | Piece list signal, open / delete / clear history / export / restore, storage status, `loadReview` / `saveReview` (stored-piece review). `describeRestore` for the merge report. |
| `importFlow.ts` | `ImportFlow` state machine (below). |
| `selection.ts` | Pure: when to ask for the score/parts (`needsChoice`), `selectionProblem` (mirror of I8), `togglePart`. |
| `review.ts` | Pure: `ReviewDraft` (hands per voice, confirmation, typed tempo + beat unit), `reviewGate` (what blocks saving; `tempoEntry` when the tempo is typed), `finalizeImport` (`applyHandAssignment` + `withUserTempo`, re-checked with `summarizeImport`), `defaultBeatUnit` from the meter. Stored pieces: `storedDraft`, `storedReviewChanges`, `finalizeStoredReview`. |
| `ImportSummary.tsx` | The summary: facts (bars, notes, chords, voices, ties, tuplets), **Hands** ("Right hand: voices …" lines from the score with cross-staff notes; Change hands opens per-voice L/R; a split voice is tagged and needs Confirm hands; `editHands` shows the controls from the start for the stored-piece review), **Tempo** (from the score with beat unit, changes and conflicts; or a required practice tempo entry), **Score check** (errors, unsupported passages, timing issues, ottavas, rolls, repeats, key/meter/clef changes, warnings, importer notes). |
| `ImportSheet.tsx` | Phase rendering; `StorageStatusLine`. |
| `ReviewSheet.tsx` | "Hands and tempo of “title”" for a stored piece (L5): loads the package, shows `ImportSummaryView` with every voice's hand editable and, when the user entered the tempo at import, that practice tempo; Save changes only when something changed and the L1 gate passes. |
| `PieceCard.tsx` | Card + delete and clear-history confirmation sheets. |
| `PieceSuggestions.tsx` | **Local, minimal** suggestion presentation (to be replaced by the shared `SuggestionList`). |
| `suggestionsData.ts` | `PieceSuggestionsModel`: load, dismiss for the session, per-piece disable, Practice this passage, refresh on history flushes. `sessionDismissals`. |
| `BackupPanel.tsx` | Export (download) and Restore (confirm → merge report or validation errors). |
| `FileButton.tsx` | `<label>` around a hidden file input (picker opens from the user's own tap, also inside sheets and on iPad). |
| `format.ts` | Relative dates, speed, bytes. |
| `testkit.ts` | Tests only: `FakeImportClient` (pure pipeline in-process, `hold` / `lateResults`), `FakeStorageManager`, `testDeps()`. |

## Import flow (`ImportFlow`)

`openFile` → size check (32 MiB, before reading) → `working: reading` → `inspect` (worker,
progress) → `choose` when there are several scores or more playable parts than the suggestion,
else straight to `build` → `review` → `save(draft)` → `idle` + `onSaved`. A build failure after a choice
returns to `choose` with the reason.

- Every async step carries a job token; `cancel()` / `close()` abort the job and bump the token,
  so a canceled or superseded job never changes `phase` again, even if a client answered late
  (tested with a misbehaving fake client and with the real worker in Playwright).
- `close()` disposes the client (terminates the worker, drops the retained file). The client
  itself terminates its worker after each build; `save` disposes it too.
- `save` refuses a draft that does not pass `reviewGate` (L1), commits source + package + piece
  with `storage.commitImport` (one transaction; a failure, incl. quota, leaves the library
  unchanged and is shown in the sheet), then calls `requestPersistentStorage()` once per session
  and `estimateStorage()` for the Library's storage status. Navigation starts as soon as the
  commit succeeds; it does not wait for those storage checks.
- Replace mode keeps the piece id, creation time, last speed, hands and repeat target, takes the
  new title/composer, and resets resume / last passage (L2). `commitImport`
  releases the old version's source, package and layouts (ST1).

## Review hands and tempo (stored pieces, DECISIONS L5)

Every voice's hand can be changed, and the practice tempo too when the user entered it at
import (`PieceRecord.userTempo`); a tempo printed in the score stays read-only (Q1). The score
version, source, bars, resume position and passages stay. `finalizeStoredReview` applies the
hands, then re-applies the user tempo (same order as at import) and re-checks readiness;
`saveReview` re-reads the piece and source and writes package + piece with `commitImport` (one
transaction; same version, so nothing is released). A new assignment gets a new `handsId`, a
new tempo a new `tempoMapId`, so either starts a separate comparison context (Q3) and earlier
results stay untouched. A new assignment also clears the version's cached layouts, which carry
each note's hand (`data-h`, used to subdue a hand).

## Suggestions (swap to the shared component)

`PieceSuggestions.tsx` renders the active list (bars with difficult vs context chips, hand and
speed label, evidence sentence, "n of 3 clean passes", Practice this passage, Dismiss for now),
Improved (collapsed), and the per-piece / Settings off states. All behavior is in
`PieceSuggestionsModel`, so swapping in `views/shared/suggestions`' `SuggestionList` is
presentational: map `onPractice → model.practice(s)`, `onDismiss → model.dismiss(s.id)`,
`onDisableSuggestions → model.setDisabled(true)`, `onEnableSuggestions → model.setDisabled(false)`,
and point `sessionDismissals` at the shared singleton (one line, see `suggestionsData.ts`).

## Tests

- `helpers.test.ts` (node): format, iPad detection, selection rules on fixtures, review gate
  (ready score, cross-staff confirmation, missing tempo + validation, errors block), finalize.
- `importFlow.test.ts` (node + fake-indexeddb): straight import + commit + one persistence
  request, part choice and validation, canceled inspect/build with late results, abort,
  unrelated/malformed/oversized files, tempo and hands gating, replace, save failure.
- `LibraryView.test.tsx` (happy-dom): empty state, iPad accept, list + open → Practice,
  storage unavailable, delete and clear-history confirmations (with/without results), the
  import UI for ready / cross-staff / no-tempo / two-part scores, cancel, rejection + re-pick,
  replace, review hands and tempo (hand change keeps the version and clears layouts; practice
  tempo change validated), suggestions (evidence, context bars, preset, session dismissal,
  per-piece and Settings off), export, restore (merge report, invalid file).
- `tests/e2e/library.spec.ts` (Chromium + WebKit, production build): no OSMD / sample
  requests, real-worker import persisted across reload, tempo entry, unrelated XML, canceling
  a 3000-bar import. `LIBRARY_SHOTS=<dir>` also saves light/dark screenshots at 1180×820,
  820×1180 and 360×740.

## Known gaps

- No score preview in the summary and no notation preview in suggestions (L4).

