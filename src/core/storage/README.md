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
default 50 MB / 256 entries), `history` (`HistoryWriterOptions`), `now`.

| Area | Methods |
| --- | --- |
| Library | `listPieces()` (latest opened first), `getPiece(id)`, `putPiece(piece)`, `updatePiece(id, patch)` (atomic read-modify-write; `undefined` removes `userTempo`/`composer`), `deletePiece(id)` |
| Import | `commitImport({ source, pkg, piece })` (one transaction), `getPackage(scoreVersionId)`, `putPackage(pkg)` (after hands are confirmed or a tempo is supplied), `getSource(scoreVersionId)` |
| Settings | `loadSettings()` (validated and merged over `DEFAULT_SETTINGS`), `saveSettings(settings)` (returns the normalized value) |
| Results | `addAttempts(records)`, `listAttempts({ pieceId } \| { contextKey } \| both, scoreVersionId? })`, `getAttempt(id)`, `loadResults(pieceId)` → `ContextResults[]` for the piece's current version |
| Suggested practice | `history` (a `HistoryWriter`, below), `loadSuggestions(pieceId, dismissed?)` → up to three plus Improved, `loadPieceHistory(pieceId)`, `setSuggestionsDisabled(pieceId, bool)`, `clearPracticeHistory(pieceId, { attempts? })` |
| Layout cache | `getLayout(key)`, `putLayout(key, scoreVersionId, value, approxBytes)` → boolean, `clearLayouts(scoreVersionId?)`, `layoutCacheStats()` |
| Backup | `exportAll()` → `Uint8Array` (save as `backupFileName()`), `restore(bytes, { settings?, route? })` → `RestoreReport` (throws `BackupError`) |
| Environment | `requestPersistentStorage()`, `isStoragePersistent()`, `estimateStorage()`, `isIndexedDbAvailable()`, `isQuotaError(e)`; `newPieceRecord(pkg)` builds a library entry with defaults |

`PieceRecord`: `id`, `title`, `composer?`, `scoreVersionId`, `createdAt`, `lastOpenedAt`,
`lastMultiplier` (last speed for the piece), `userTempo?` (`{ beatBpm, beatUnit }`),
`lastHands`, `resume` (`{ occ, position, group?, hands, multiplier, savedAt }` or null; the
`position` Rational is authoritative), `lastPassage`, `repeatTarget`. A `savedPassages`
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
retries; a batch failing three times is dropped and reported through `onError`; one malformed
record is dropped alone. Scheduling is injectable for tests. Ordinary-reading attempts feed
the measure histories but their records are not stored unless `keepReadingAttempts` is set;
Preview records nothing.

## Database "pianissimo", version 1

| Store | Key | Value / indexes |
| --- | --- | --- |
| `pieces` | `id` | `PieceRecord`; indexes `lastOpenedAt`, `scoreVersionId` |
| `sources` | `scoreVersionId` | `SourceFileRecord` (original bytes) |
| `packages` | `scoreVersionId` | `ScorePackage` |
| `settings` | `"app"` | `AppSettings` |
| `attempts` | `id` | `AttemptRecord`; indexes `pieceId`, `contextKey` |
| `measureHistory` | `[pieceId, barKey]` | `BarRecord`; index `pieceId` |
| `suggestionState` | `pieceId` | `{ pieceId, disabled, suggestions[] }` |
| `abandonEvents` | `[pieceId, barKey]` | `{ pieceId, measureContextKey, occ, events[] }`; index `pieceId` |
| `layoutCache` | `key` | `{ key, value }` (the renderer's serialized layout) |
| `layoutMeta` | `key` | `{ key, scoreVersionId, approxBytes, createdAt, lastUsedAt }`; indexes `scoreVersionId`, `lastUsedAt` |

Heavy data (package, source) is separate from the small piece records so the library lists
without loading scores. Upgrades add branches on `oldVersion` in `schema.ts` and never drop
user stores. A connection told to upgrade by another tab closes itself.

## Guarantees

- **Atomic import.** Source, package and piece commit in one transaction (`runTx` aborts on
  any failure, including synchronous structured-clone errors); a failed import leaves every
  existing piece intact and never stores a piece without its package. Replacing a piece's
  source removes the old version's source, package and layouts once no piece uses them; its
  attempts and histories stay under the old `scoreVersionId` and are never mixed with the
  new one (every context key and suggestion carries the version).
- **Shared versions.** Two pieces may share a `scoreVersionId`; deleting one keeps the
  package until the last piece goes.
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

## Backup format (`*.pianissimo.zip`, format 1)

```
manifest.json         { format: "pianissimo-backup", formatVersion, appVersion, createdAt, dbVersion, counts }
settings.json         { settings: AppSettings | null }
pieces.json  attempts.json  measureHistory.json  suggestionState.json  abandonEvents.json
sources.json          [{ scoreVersionId, fileName, packaging, sha256, bytesSha256, size, file }]
sources/<id>.bin      original bytes (stored, not deflated, for .mxl)
packages/<id>.json    one ScorePackage per score version   (<id> is encodeURIComponent)
```

Export reads and compresses packages and sources one at a time and yields between 1 MiB
chunks; the zip layer (`backup.ts`, `zipio.ts`, `merge.ts`) is a lazily imported chunk, so
opening the library does not load it. Restore:

1. **Validates everything first, writes nothing on failure** (`BackupError` with a code,
   a readable message and up to 20 record-level `problems`): not a zip / not a Pianissimo
   backup, truncated or damaged zip, files missing or counts disagreeing with the manifest,
   a format newer than this app ("update the app"), records of the wrong shape, packages of an
   unsupported format, source size or SHA-256 mismatch, size limits (512 MiB per entry, 2 GiB
   total, 50 000 entries).
2. **Merges by id in one transaction**, deleting nothing local. Attempts and sources are
   immutable (an existing id is kept). Pieces: the more recently opened record supplies the
   state; a tempo or composer present on either side is kept. Bar histories: the more recently updated record wins. Suggestions: union by id, newer
   `updatedAt` wins, the local per-piece disable switch is kept, improved entries trimmed to
   ten. Abandon events: union, newest five. A package is replaced only when the backup's one
   has more user input (confirmed hands, a tempo). Pieces whose package is in neither the
   backup nor this browser are skipped with a warning, with their records.
3. **Settings** are replaced by the backup's (`settings: 'keep'` leaves local ones alone).
   The MIDI **route** (port ids, output verification, echo result) is device- and
   connection-specific, so this browser's route is kept (`route: 'backup'` restores it too).

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
