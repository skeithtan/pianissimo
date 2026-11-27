# core/storage

Local persistence on IndexedDB (`idb` 8.0.4) plus export/restore (`fflate` 0.8.3). The browser
is the only database; there is no server. Everything is plain JSON except the retained source
bytes. Tests use `fake-indexeddb/auto` with a fresh database name per test.

Spec: "Storage and recovery", "Suggested practice" (persistence), "Results and timing"
(attempt records), "Persistent score labels" (settings persist and travel in export/restore),
"Execution and rendering architecture" (history written in asynchronous batches, cached
geometry, deferred assets).

## Using it

```ts
import { openStorage, newPieceRecord } from 'core/storage';

const storage = await openStorage();            // database "pianissimo"; openStorage(name, options)
```

`options`: `appVersion` (recorded in backups), `layoutCache` (`{ maxBytes, maxEntries }`,
default 50 MB / 256 entries), `history` (`HistoryWriterOptions`), `now`, `onBlocked` (the
upgrade waits for another tab that keeps an older version open; the app shows a notice).
Opening also removes the blocks of takes whose save a closed page left unfinished.

| Area | Methods |
| --- | --- |
| Library | `listPieces()` (latest opened first), `getPiece(id)`, `putPiece(piece)`, `updatePiece(id, patch)` (atomic read-modify-write; `undefined` removes `userTempo`/`composer`), `deletePiece(id)` |
| Bundled library | `needsLibraryExpansion()` checks the release marker and `needsInitialPieces()` identifies a fresh library; `initializeLibrary(inputs, mode?)` atomically installs a nonempty batch and seals eligibility |
| Import | `commitImport({ source, pkg, piece, replaceSharedPackage? })` (one transaction; see Shared versions), `getPackage(scoreVersionId)`, `putPackage(pkg)` (after hands are confirmed or a tempo is supplied), `getSource(scoreVersionId)` |
| Settings | `loadSettings()` (validated and merged over `DEFAULT_SETTINGS`), `saveSettings(settings)` (returns the normalized value) |
| Results | `addAttempts(records)`, `listAttempts({ pieceId } \| { contextKey } \| both, scoreVersionId? })`, `listRecentAttempts(pieceId, limit)` (reverse cursor over `pieceId`, used to seed session mistake memory), `getAttempt(id)`, `loadResults(pieceId)` → `ContextResults[]` for the piece's current version |
| Suggested practice | `history` (a `HistoryWriter`, below), `loadSuggestions(pieceId, dismissed?)` → up to three plus Improved, `loadPieceHistory(pieceId)`, `setSuggestionsDisabled(pieceId, bool)`, `clearPracticeHistory(pieceId, { attempts? })` |
| Layout cache | `getLayout(key)`, `putLayout(key, scoreVersionId, value, approxBytes)` → boolean, `clearLayouts(scoreVersionId?)`, `layoutCacheStats()` |
| Recordings | `listRecordings()`, `saveRecording(info, { midi, audio })` (reads the WAV Blob a block at a time; listed only once complete), `getRecordingFiles(id)` → `{ midi, audio }` Blobs (audio assembled from the blocks), `getRecordingMidi(id)`, `discardRecordings(ids)` / `restoreRecordings(ids)` (out of every list at once, and back), `removeDiscardedRecordings(ids)` (for good; one that was brought back is left alone), `recordingsSummary()` → `{ count, bytes }` |
| Backup | `exportAll({ includeRecordings? })` → `Blob` built from parts (save as `backupFileName()`), `restore(fileOrBytes, { settings?, route? })` → `RestoreReport` (throws `BackupError`) |
| Environment | `requestPersistentStorage()`, `isStoragePersistent()`, `estimateStorage()`, `isIndexedDbAvailable()`, `isQuotaError(e)`; `newPieceRecord(pkg)` builds a library entry with defaults |

`PieceRecord`: `id`, `title`, `composer?`, `scoreVersionId`, `createdAt`, `lastOpenedAt`,
`lastMultiplier` (last speed for the piece), `userTempo?` (`{ beatBpm, beatUnit }`),
`mode?` (the learner's mode, `PracticeMode`; absent on older records, where the session derives it
with `openingMode`; validated on restore), `lastHands` (both, left or right; 'none' only on older
records, where it meant Listen), `resume` (`{ occ, position, group?, hands, multiplier, savedAt }` or null; the
`position` Rational is authoritative), `lastPassage`, `repeatTarget`, `ladder?` (the speed
ladder, `LadderSettings { goal, step }` multipliers or null; absent on records written before it,
validated on restore: finite, goal in [0.05, 10], step in (0, 1]; `newPieceRecord` sets null),
`rhythm?` (older records only: Keep time was on; never written, validated on restore),
`repeatOpen?` (Repeat mode was on when the piece was last practiced, DECISIONS U98: Practice
reopens it over `lastPassage`; a boolean, absent on older records = closed, validated on restore;
`newPieceRecord` leaves it absent). Attempt
records with `context.transport` 'strict' (Keep time) restore like any other. A `savedPassages`
key left by records written before 2026-10-31 is ignored.
Saving the resume position is a plain `updatePiece(id, { resume })` on a small record: call it
on pause, seek, hide and every few seconds of reading, not per MIDI event.

### Recording practice (session wiring)

```ts
storage.history.attachLifecycle();               // flush on pagehide / page hidden
storage.history.queueAttempt(attemptRecord);     // O(1): push + arm one idle/timeout flush
storage.history.queueAbandon(abandonEvent);
const shown = await storage.loadSuggestions(pieceId, sessionDismissals);
storage.history.subscribe((report) => { /* report.suggestionsChanged lists pieces to refresh */ });
```

`HistoryWriter` never touches IndexedDB from `queue*`. Flushes run from an idle callback
(2 s timeout) or a 500 ms timer where there is none (Safari), on `pagehide` /
`visibilitychange` to hidden, on `flush()`, `getHistory()`, `loadSuggestions()`,
`loadResults()`, `exportAll()` and before deleting or restoring. A flush ingests the queued
records through `core/history` (suggestion detection and recovery), then writes attempts and
only the changed history records in one transaction. A failed flush keeps its items and
retries; a batch failing three times is dropped and reported through `onError` (with the number of lost records; the app shows one warning
notice per failure streak); one malformed
record is dropped alone. Scheduling is injectable for tests. Ordinary-reading attempts feed
the measure histories but their records are not stored unless `keepReadingAttempts` is set;
Preview records nothing.

## Database "pianissimo", version 4

| Store | Key | Value / indexes |
| --- | --- | --- |
| `recordings` | `id` | `RecordingInfo`: metadata, note counts, `passageRange` (absent on older takes). Lists read only this. |
| `recordingFiles` | recording ID | `{ midi, type, blocks, bytes }`: the MIDI file and what to expect in `recordingBlocks`. A take the version 4 upgrade could not convert keeps the schema 3 shape `{ midi, audio: ArrayBuffer[] }`; every reader accepts both. |
| `recordingBlocks` | `[recordingId, blockIndex]` | One block of the WAV file, at most 4 MiB (`RECORDING_BLOCK_BYTES`); read and deleted by key range. |
| `pendingRecordings` | recording ID | `{ startedAt }` while a take's blocks are being written; installation-local. |
| `pieces` | `id` | `PieceRecord`; indexes `lastOpenedAt`, `scoreVersionId` |
| `sources` | `scoreVersionId` | `SourceFileRecord` (original bytes) |
| `packages` | `scoreVersionId` | `ScorePackage` |
| `settings` | `"app"` | `AppSettings` |
| `libraryState` | `"initial-library"` | `"pending"` or `"complete"`; installation-local, excluded from backup |
| `attempts` | `id` | `AttemptRecord`; indexes `pieceId`, `contextKey` |
| `measureHistory` | `[pieceId, barKey]` | `BarRecord`; index `pieceId` |
| `suggestionState` | `pieceId` | `{ pieceId, disabled, suggestions[] }` |
| `abandonEvents` | `[pieceId, barKey]` | `{ pieceId, measureContextKey, occ, events[] }`; index `pieceId` |
| `layoutCache` | `key` | `{ key, value }` (the renderer's serialized layout) |
| `layoutMeta` | `key` | `{ key, scoreVersionId, approxBytes, createdAt, lastUsedAt }`; indexes `scoreVersionId`, `lastUsedAt` |

Heavy data (package, source) is separate from the small piece records so the library lists
without loading scores. Upgrades add branches on `oldVersion` in `schema.ts` and never drop
user stores. A connection told to upgrade by another tab closes itself; an upgrade blocked by
another tab calls `onBlocked`.

Takes (`recordings.ts`). Chrome refuses any single stored value above 133,169,152 bytes, so a
take's WAV is stored as 4 MiB blocks: far below that limit, nothing to hold in memory on a 4 GB
tablet, under 200 records for an hour of 48 kHz stereo, and the block size schema 3 already used
(converted takes and older backups keep their blocks). A save writes one block per transaction,
reading the Blob one block at a time, under a `pendingRecordings` marker; the last transaction
checks that every block is present, writes the files record and the metadata and removes the
marker, so a half-written take is never listed. A failed save removes its blocks at once; a save
cut short by a closed page is removed when the database is next opened, once its marker is more
than an hour old (a save running in another tab is younger; were it removed anyway, its last
transaction would find blocks missing and fail rather than list a broken take). A discarded take keeps
its files and its metadata with `discardedAt`, which lists, sums and backups leave out, until it is removed;
what a closed page left is removed on an open more than ten minutes later, and the same take saved or
restored from a backup takes its place. The version 4
upgrade converts schema 3 takes inside the upgrade transaction, one take at a time and skipping
converted ones; a take whose blocks cannot be written keeps its schema 3 record (its partial
blocks are removed) and the upgrade continues. If the upgrade transaction fails as a whole (a
browser may refuse the temporary extra space when it commits), the database is opened again
without converting, and those takes stay readable in the schema 3 shape.

Only a database created from version zero starts with pending initial-library eligibility.
Ordinary imports, `putPiece`, and successful restores complete the first-use marker.
The catalog expansion has a separate release marker. First use installs the whole catalog
and completes both markers. For existing libraries, the expansion skips score versions
already in the library and appends the remaining new pieces in catalog order. The pieces,
sources, packages, and markers commit in one transaction. Concurrent tabs serialize on
the release marker. Failed writes leave the existing library intact and can retry.
Deleting any piece never resets either marker. The app's bundled-piece service fetches the
sources and normalizes them in the existing import worker before calling this storage API.
These pieces use ordinary IDs and records, including ordinary deletion, history, and backup behavior.

## Guarantees

- **Atomic import.** Source, package and piece commit in one transaction (`runTx` aborts on
  any failure, including synchronous structured-clone errors); a failed import leaves every
  existing piece intact and never stores a piece without its package. Replacing a piece's
  source removes the old version's source, package and layouts once no piece uses them; its
  attempts and histories stay under the old `scoreVersionId` and are never mixed with the
  new one (every context key and suggestion carries the version).
- **Shared versions.** Two pieces may share a `scoreVersionId` (importing the same file twice,
  or replacing a score with a file another piece uses); deleting one keeps the package until the
  last piece goes. The package (reviewed hands, practice tempo) is shared: `commitImport` keeps
  the stored package, source and layouts when another piece uses the version, and the new piece
  takes that piece's `userTempo`, so piece records and package never disagree. Review
  (`replaceSharedPackage: true`) writes the shared package and gives the other pieces the same
  `userTempo`. Overwriting a stored package with different hands or notation drops the
  version's cached layouts in the same transaction.
- **Delete cascade.** `deletePiece` removes the piece, attempts, measure histories,
  suggestion state, abandon events, and (when unshared) source, package and layouts, in one
  transaction, and discards queued history records for it.
- **Layout cache.** Derived data. LRU by total `approxBytes` and entry count; a read
  refreshes only the meta record; an entry larger than the whole cache, a value that cannot be
  cloned, or any storage error yields `false`/`undefined`, never an exception; half-written
  entries are dropped on read. Never exported.
- **Settings.** `normalizeSettings` validates field by field: absent or malformed values take
  the default, deliberate `null`s (cleared threshold, unset pedal) are kept, label rules merge
  per clef, unknown clefs are preserved. Settings added later get defaults automatically.
  `rhythm.toleranceMs` (Keep time) is clamped to [40, 500] and rounded to whole ms; a
  non-number takes the default (150).

## Backup format (`*.pianissimo.zip`, format 1)

```
manifest.json         { format: "pianissimo-backup", formatVersion, appVersion, createdAt, dbVersion, counts,
                        recordingsExcluded? (true: the player left recordings out) }
settings.json         { settings: AppSettings | null }
pieces.json  attempts.json  measureHistory.json  suggestionState.json  abandonEvents.json
sources.json          [{ scoreVersionId, fileName, packaging, sha256, bytesSha256, size, file }]
sources/<id>.bin      original bytes (stored, not deflated, for .mxl)
packages/<id>.json    one ScorePackage per score version   (<id> is encodeURIComponent)
recordings.json       RecordingInfo[] (only when there are takes; counts.recordings matches)
recordings/<id>.mid   a take's MIDI file
recordings/<id>.wav.<i>  its WAV file in stored parts of at most 4 MiB, from 0 (one empty part for a take without audio)
```

The recordings layout is the one schema 3 wrote, so backups from either version restore in both.
Export reads and compresses packages and sources one at a time and yields between 1 MiB
chunks, and adds a take's audio one block at a time; the archive is a Blob assembled from parts
(no array of the whole archive, each block released once added). With `includeRecordings: false`
nothing of the takes is written and the manifest says `recordingsExcluded: true`. Export refuses
(`BackupError` 'too-large') a backup over the restore limits below, checked from the takes'
stored sizes before reading any audio; the message suggests turning recordings off when they
are what makes it too large. The zip layer (`backup.ts`, `zipio.ts`, `merge.ts`) is a lazily
imported chunk, so opening the library does not load it. `zipio.ts` reads the archive's central
directory itself, from a picked File by slices or from bytes. Restore:

1. **Validates everything first, writes nothing on failure** (`BackupError` with a code,
   a readable message and up to 20 record-level `problems`): not a zip / not a Pianissimo
   backup, truncated or damaged zip, files missing or counts disagreeing with the manifest,
   a format newer than this app ("update the app"), records of the wrong shape, packages of an
   unsupported format, source size or SHA-256 mismatch, size limits (512 MiB per entry, 2 GiB
   total, 50 000 entries).
2. **Merges library, results, history and settings by id in one transaction**, deleting nothing local. Attempts and sources are
   immutable (an existing id is kept). Pieces: the more recently opened record supplies the
   state; a tempo or composer missing there is taken from the other side only when both are on
   the same score version. Bar histories: the more recently updated record wins. Suggestions: union by id, newer
   `updatedAt` wins, the local per-piece disable switch is kept, improved entries trimmed to
   ten. Abandon events: union, newest five. A package is replaced when the backup's one has more user
   input (confirmed hands, a tempo) and never by one with less; with equal input it follows the
   piece records (the backup's package when the version's most recently opened piece after the
   merge is the backup's record), and a replaced package drops the version's cached layouts. Pieces whose package is in neither the
   backup nor this browser are skipped with a warning, with their records.
3. **Settings** are replaced by the backup's (`settings: 'keep'` leaves local ones alone).
   The MIDI **route** (port ids, output verification, echo result), the metronome's audio
   output device (`metronome.outputId`) and the remembered recording input (`recording`) are
   device-specific, so this browser's are kept
   (`route: 'backup'` restores them too).
4. **Takes**, after that transaction has committed, each in its own transactions, reading its
   audio from the file a block at a time. A take already here (same id) is kept; one that
   cannot be stored (storage full, a value this browser refuses) is skipped, named in
   `warnings` and counted in `RestoreReport.recordings` (`added`, `skipped`, `failed`); it
   never undoes the rest.

## Decisions and interpretations

- `clearPracticeHistory` removes measure histories, suggestions and abandon events but keeps the
  attempt records (scorecards, best times) unless `{ attempts: true }`. The per-piece
  "disable suggestions" switch survives it.
- Restore never trusts the route and verification state of another device (see above).
- The history cache inside `HistoryWriter` assumes one writer per database (one tab). After
  any other change to the history stores call `history.forget()` (the facade does this for
  `deletePiece`, `restore`, `clearPracticeHistory` and `setSuggestionsDisabled`).
- Histories are keyed per piece and never pruned by version; bars and suggestions of a
  replaced source stay inert (filtered by `scoreVersionId`) until the piece is deleted or its
  history cleared.
- Backup file names carry the local date; the app version comes from `openStorage` options.

## Spec coverage

Done and tested: persist package before import completes; failed import leaves pieces intact;
score-version separation; settings, last speed, hands, resume position and
repeat target per piece; attempt, measure-history, suggestion and abandon persistence;
export/restore with validation, merge and settings (including label rules and suggestion
progress); bounded layout cache; persistence/estimate/quota helpers; batched asynchronous
history writes with lifecycle flushing.

Left or outside this package: calling `requestPersistentStorage()` after the first import and
showing quota/persistence status (views); throttled resume-position saving, wake lock and
suspension recovery (session wiring); offline relaunch caching (service worker, not promised
until validated); attempt retention limits (attempt records are small but unbounded; a prune
policy can be added without a schema change); real-browser verification of IndexedDB eviction
and Safari/MIDIWeb behavior 🔒.
