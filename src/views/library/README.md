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

- **Header**: Library, with a secondary Add score action when pieces exist (no piece count,
  no caption). The empty state gives Add score the primary emphasis and points to Settings →
  Backup.
- **Ordinary rows**: title, composer and a status line on the left; Sheet music (music note and the
  word), an icon-only Options button (`more`; name "Options for …", `aria-expanded` /
  `aria-controls`) and a chevron on the right, on one line at every width (the chevron glyph
  is hidden at ≤480px; its button stays, 4 px wide, never zero: Voice Control, screen-reader
  focus and automated clicks act on its own frame). All entries use the same controls,
  including the three pieces initially provided by `app/initialPieces`. Options hold Rename,
  hands/tempo review, suggestion preferences, clear history, and Delete.
- **The whole row opens Practice** (`model.open`, like Continue practice). Nothing is nested:
  one real button per card, the chevron ("Practice …") or Continue practice, carries a
  `::after` that covers the card (stretched target). Sheet music, the Options wrapper (and its menu)
  and the suggestions block are `position: relative; z-index: 1`, so their own dead space
  never opens Practice; an open menu's wrapper rises to z-index 20 so it paints over the next
  rows. Hover (`hover: hover`) and press tint the card with `--hover`; keyboard focus on the
  stretched button rings the whole card (`:has(:focus-visible)`, the global focus ring). The
  button's press transform is turned off: it would make the button the `::after`'s containing
  block mid-press. The text is not selectable, so a tap never flashes a selection.
- **Dismissing Options**: a tap outside an open menu only closes it, as iPadOS menus do, since
  the rows' targets cover nearly the whole list. The outside `pointerdown` that closes the menu
  arms `swallowNextClick` (`PieceCard.tsx`): a capture-phase `click` listener on `document`
  stops and cancels the click that ends that press, before any handler or default action, so
  the tap opens no row, Sheet music, Add score or Settings. Exception: another row's Options button
  (`data-piece-options`) is not swallowed, so it closes this menu and opens its own in one tap;
  the same row's button still toggles its menu closed, and Escape is unchanged. The mark ends
  with that click, the next `pointerdown`, a `pointercancel` (the press became a scroll), 500 ms
  after `pointerup` (a delayed touch click still arrives in time) or 1.5 s after the press
  began, so it never eats a later, unrelated click (a keyboard click has no `pointerdown`).
- **Status line** (ordinary rows), from the piece record alone (no package or attempt reads):
  `openedStatus` in `continuation.ts`. "Not opened yet" while `lastOpenedAt <= createdAt`
  (`neverOpened`): an import or a copy stores both times equal and the initial pieces store
  `lastOpenedAt` a little earlier; every open stores a later time (`markOpened` from Practice,
  Sheet music, a suggestion, Open existing piece; the Practice and Sheet music views also bump it when they
  load). Add and open calls `markOpened(id, createdAt + 1)` before opening Practice, so it
  counts even when the clock has not moved since the commit. Otherwise "Opened yesterday",
  "Opened 3 days ago" (`formatRelativeTime`); never "practiced", since Sheet music opens too (L9).
- **Rename**: "Rename piece" edits the library entry's title (required) and composer (optional;
  empty removes it). Both are trimmed, inner whitespace collapsed and capped at 120 characters
  (`normalizePieceName`); Save needs a non-empty title and a real change. Only the piece record
  changes: the score package (`model.meta`) and the source keep the score's own metadata, and
  `lastOpenedAt` (the list order) is untouched. Every screen reads `PieceRecord.title` /
  `composer`, so the row and its button labels follow after the refresh; no success notice.
  Backup restore resolves a piece by `lastOpenedAt` (`mergePiece`), which a rename does not
  change: on a tie the local record, and its name, stay; a composer the rename removed is
  filled back in from the backup's record of the same score version.
- **Continue practice**: the most recently opened piece with a saved resume position or active
  Repeat receives the primary action (its stretched target; no chevron) and one context line,
  its status (`continuationContext`, no "Opened …" line): where it resumes ("From the start"
  at position 0, "From bar 9", "From bar 9, beat 3" off the first beat, "Repeat bars 5–8"),
  the hands in lower case ("both hands", "right hand", "left hand", "listening"), and the speed
  unless it reads 100% ("80% speed"). Only that piece's package is loaded to resolve printed
  bar/pass labels; no engraving runs here. Sheet music also updates lastOpenedAt, so the Library
  never describes it as "last practiced."
- **Suggestions**: useful active/Improved suggestions appear outside management Options.
  Empty explanations are omitted; Options retain per-piece enable/disable controls.
- **Import sheet**: Add score shows progress/cancel, movement or part choices when needed,
  then a compact piece/hands/tempo summary. Import details holds counts and successful checks.
  Genuine blockers and consequential warnings remain visible; hand/tempo review is retained.
  **Add and open** commits the ready piece, closes the sheet, and opens Practice paused.
  The subsequent Start or Play owns audio unlocking and microphone permission.
- **Duplicates**: Open existing piece is primary. Add another copy is secondary, uses the
  stored package's reviewed hands and tempo, and offers no edits that would be ignored.
- Backup/restore and storage status remain in Settings → Backup; closing Settings refreshes
  the Library. Delete and clear history retain their existing confirmations.

## Files

| File | Role |
| --- | --- |
| `LibraryView.tsx` | Registered view (`LibraryView`) and the injectable `Library({ deps })`. |
| `deps.ts` | `LibraryDeps` (storage, import client factory, `navigator.storage`, clock, download, settings flush/reload, iPad detection) + context. |
| `libraryModel.ts` | Piece list signal, open / `rename` / delete / clear history / export / restore, storage status, `loadReview` / `saveReview` (stored-piece review). `describeRestore` for the merge report. Pure `normalizePieceName` with `TITLE_MAX_LENGTH` / `COMPOSER_MAX_LENGTH`. |
| `importFlow.ts` | `ImportFlow` state machine (below). |
| `selection.ts` | Pure: when to ask for the score/parts (`needsChoice`), `selectionProblem` (mirror of I8), `togglePart`. |
| `review.ts` | Pure: `ReviewDraft` (hands per voice, confirmation, typed tempo + beat unit), `reviewGate` (what blocks saving; `tempoEntry` when the tempo is typed), `finalizeImport` (`applyHandAssignment` + `withUserTempo`, re-checked with `summarizeImport`), `defaultBeatUnit` from the meter. Stored pieces: `storedDraft`, `storedReviewChanges`, `finalizeStoredReview`. |
| `ImportSummary.tsx` | The summary: facts (bars, notes, chords, voices, ties, tuplets), **Hands** ("Right hand: voices …" lines from the score with cross-staff notes; Change hands opens per-voice L/R; a split voice is tagged and needs Confirm hands; `editHands` shows the controls from the start for the stored-piece review), **Tempo** (from the score with beat unit, changes and conflicts; or a required practice tempo entry), **Score check** (compact import keeps successful checks under Import details; errors, unsupported passages, timing issues, ottavas, rolls, repeats, key/meter/clef changes, warnings, importer notes). |
| `ImportSheet.tsx` | Phase rendering; `StorageStatusLine`. |
| `ReviewSheet.tsx` | "Hands and tempo of “title”" for a stored piece (L5): loads the package, shows `ImportSummaryView` with every voice's hand editable and, when the user entered the tempo at import, that practice tempo; Save changes only when something changed and the L1 gate passes. |
| `PieceCard.tsx` | Card (stretched Practice target, status line, Sheet music, icon-only Options) + delete and clear-history confirmation sheets. |
| `continuation.ts` | Pure: which piece is featured (`continuingPiece`), its context line (`continuationContext`), and an ordinary row's status (`neverOpened`, `openedStatus`). |
| `RenameSheet.tsx` | "Rename piece": a form with Title and Composer fields, prefilled from the piece on every open, the title focused and selected; Enter or Save calls `model.rename`, a failure shows in the sheet. |
| `PieceSuggestions.tsx` | Shared `SuggestionList` bound to the per-piece model, with useful content outside Options and preference controls in Options. |
| `suggestionsData.ts` | `PieceSuggestionsModel`: load, dismiss for the session, per-piece disable, Practice this passage, refresh on history flushes. `sessionDismissals`. |
| `FileButton.tsx` | `<label>` around a hidden file input (picker opens from the user's own tap, also inside sheets and on iPad). |
| `format.ts` | Relative dates, speed, bytes. |
| `testkit.ts` | Tests only: `FakeImportClient` (pure pipeline in-process, `hold` / `lateResults`), `FakeStorageManager`, `testDeps()`. |

## Import flow (`ImportFlow`)

`openFile` → size check (32 MiB, before reading) → `working: reading` → `inspect` (worker,
progress) → `choose` when there are several scores or more playable parts than the suggestion,
else straight to `build` → `review` → `save(draft)` (or duplicate `saveCopy(pieceId)`) → `idle` + `onSaved`. A build failure after a choice
returns to `choose` with the reason.

- Every async step carries a job token; `cancel()` / `close()` abort the job and bump the token,
  so a canceled or superseded job never changes `phase` again, even if a client answered late
  (tested with a misbehaving fake client and with the real worker in Playwright).
- `cancel()` and `close()` dispose the client (terminate the worker, drop the retained file); a
  later `openFile` creates a new one. The client itself terminates its worker after each build;
  `save` disposes it too.
- Closing the sheet while "Saving…" is ignored (X and Escape); if the flow is closed anyway
  (the view unmounts), the commit still completes but `onSaved` is not called: no notice and no
  Practice handoff; the library lists the piece on its next refresh.
- `save` refuses a draft that does not pass `reviewGate` (L1), commits source + package + piece
  with `storage.commitImport` (one transaction; a failure, incl. quota, leaves the library
  unchanged and is shown in the sheet), then calls `requestPersistentStorage()` once per session
  and `estimateStorage()`. Navigation starts as soon as the
  commit succeeds; it does not wait for those storage checks.

## Review hands and tempo (stored pieces, DECISIONS L5)

Every voice's hand can be changed, and the practice tempo too when the user entered it at
import (`PieceRecord.userTempo`); a tempo printed in the score stays read-only (Q1). The score
version, source, bars, resume position and passages stay. `finalizeStoredReview` applies the
hands, then re-applies the user tempo (same order as at import) and re-checks readiness;
`saveReview` re-reads the piece and source and writes package + piece with `commitImport` (one
transaction; same version, so nothing is released; `replaceSharedPackage`, so a score shared
with another piece is updated for both). A new assignment gets a new `handsId`, a
new tempo a new `tempoMapId`, so either starts a separate comparison context (Q3) and earlier
results stay untouched. A new assignment also clears the version's cached layouts (inside `commitImport`), which carry
each note's hand (`data-h`, used to subdue a hand).

## Suggestions (swap to the shared component)

`PieceSuggestions.tsx` renders the active list (bars with difficult vs context chips, hand and
speed label, evidence sentence, "n of 3 clean passes", Practice this passage, Dismiss for now),
Improved (collapsed); the per-piece / Settings off controls appear in Options. All behavior is in
`PieceSuggestionsModel`, so swapping in `views/shared/suggestions`' `SuggestionList` is
presentational: map `onPractice → model.practice(s)`, `onDismiss → model.dismiss(s.id)`,
`onDisableSuggestions → model.setDisabled(true)`, `onEnableSuggestions → model.setDisabled(false)`,
and point `sessionDismissals` at the shared singleton (one line, see `suggestionsData.ts`).

## Tests

- `helpers.test.ts` (node): format, iPad detection, selection rules on fixtures, review gate
  (ready score, cross-staff confirmation, missing tempo + validation, errors block), finalize.
- `importFlow.test.ts` (node + fake-indexeddb): straight import + commit + one persistence
  request, part choice and validation, canceled inspect/build with late results, abort,
  unrelated/malformed/oversized files, tempo and hands gating, save failure.
- `libraryModel.test.ts` (node + fake-indexeddb): export flushes settings first;
  `normalizePieceName` (whitespace, blank composer, length caps); `rename` stores the name and
  keeps order, resume, version and the package's own title, removes an empty composer, refuses
  an empty title, and reports a deleted piece.
- `continuation.test.ts` (node): featured piece choice; context line wording (from the start,
  bar alone on beat 1 and with the beat otherwise, printed passes, lower-case hands, speed
  omitted at 100%, restored positions outside the score); status line (never opened while
  `lastOpenedAt <= createdAt`, relative "Opened …" times).
- `LibraryView.test.tsx` (happy-dom): empty state, iPad accept, list + open → Practice (no
  piece count or Study caption; status lines; chevron with no visible word and the "Practice …"
  name), "Not opened yet", featured context line without "Opened …", icon-only Options keeps
  its name and menu link, a tap outside an open menu only closes it (on another row's Sheet music or
  Practice target; the next tap opens Practice; another row's Options button switches menus in
  one tap; a press that turns into a scroll swallows nothing), storage unavailable, rename
  (first option, prefilled each open, title focused and selected,
  Save gating, submit updates the row and its labels, storage failure keeps the sheet open),
  delete and clear-history confirmations (with/without results), the
  import UI for ready (Add and open marks the piece opened) / cross-staff / no-tempo / two-part
  scores, cancel, rejection + re-pick,
  review hands and tempo (hand change keeps the version and clears layouts; practice
  tempo change validated), suggestions (evidence, context bars, preset, session dismissal,
  per-piece and Settings off), refresh when Settings close.
- `tests/e2e/library.spec.ts` (Chromium + WebKit, production build): no OSMD / sample
  requests, real-worker import persisted across reload, tempo entry, unrelated XML, canceling
  a 3000-bar import, rename (title selected on open, Enter saves, kept across reload), a tap on
  a row's title opens Practice while Sheet music, Options and empty space in the open menu do not,
  a click or touch tap outside an open menu only closes it (no late touch click) and the next
  one opens the row, another row's Options button switches menus. `LIBRARY_SHOTS=<dir>` also saves light/dark screenshots at 1180×820, 820×1180 and 360×740.

## Known gaps

- No score preview in the summary and no notation preview in suggestions (L4).

