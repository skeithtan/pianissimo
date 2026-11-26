# Architecture

How the pieces fit. Module owners update their section when they change a public API.

## Interface languages

`core/model/language.ts` defines supported language tags and matches ordered device preferences. The persisted `AppSettings.view.language` field defaults to `system`. Missing and unrecognized settings normalize to that default. `app/language.ts` observes the setting and browser language changes, loads catalogs, and updates the document language and reactive message reader together. It does nothing on the default setting while stored settings load; instead it caches the last resolved language in localStorage and starts loading that catalog before the first render, which waits for it at most 300 ms. A catalog that fails to load leaves the current language on screen with a notice and is tried again on the next language change or `online` event. The English shell starts without loading a catalog. The service worker precaches every production language chunk. The app loads and saves settings as soon as IndexedDB opens, independently of the first-run score installation.

Use `msg('English source', ...literalValues)` from `i18n/messages.ts` when presenting text. Keep score content and hardware names as literal arguments. Translated templates may move or repeat numbered fields. Add the next unused ID to `i18n/locales/en-US.json` and use the same ID in each full catalog. View tests render under a pseudo-catalog from `views/shared/catalogTesting.ts` that marks every catalog string, and fail on visible text or accessible names that bypass `msg`; give a word with two meanings its own source sentence. Japanese has a full catalog and uses Japanese counters for practice and repeat counts. Canadian French inherits the French catalog and overrides regional wording. `i18n/importMessage.ts` recognizes diagnostic templates produced by import workers and older saved scores. Stored comparison keys and score data retain their original meaning when the interface language changes.

## Data flow

```
file picker ──► import worker (core/import) ──► ScorePackage {model, renderXml}
                                                     │  persisted (core/storage, IndexedDB)
                                                     ▼
  import summary (views/library): pick score/parts, hands from the score (confirm only a split voice), supply tempo if missing
                                                     │
                                                     ▼
   ┌─────────────── Practice session (app/session) ───────────────┐
   │ MIDI adapter (core/midi) ─► engine (core/engine) ─► UI signals │
   │                              ▲      │                         │
   │ transport (core/playback) ───┘      ▼                         │
   │   ├─ MIDI output backend      history (core/history)          │
   │   └─ browser-audio backend    storage (async batches)         │
   │ strip renderer (render/) ◄── visual state (rAF-batched)        │
   └────────────────────────────────────────────────────────────────┘
```

## Shared contracts

| File | What it defines |
| --- | --- |
| `src/core/music/rational.ts` | Exact whole-note arithmetic. All positions/durations. |
| `src/core/music/pitch.ts` | `Spelling` (step, alter, octave), MIDI conversion. |
| `src/core/music/tempo.ts` | `TempoMapData`, seconds ↔ positions, multiplier math, BPM entry. |
| `src/core/model/score.ts` | `ScoreModel`, `PerformedNote`, ottava/arpeggio/pedal/dynamics, `ScorePackage`. |
| `src/core/model/settings.ts` | `AppSettings` and spec defaults (`SETTINGS_VERSION` 2: sound destination `'auto'`, S4; `metronome.keepTime`, `metronome.outputId` and `recording` added without a bump, P20, U114 and D20). |
| `src/core/model/practice.ts` | Comparison contexts, `AttemptRecord`, `MeasureTraversal`, passages; `TRANSPORT_KINDS` (the runtime list `TransportKind` is derived from). |
| `src/core/midi/types.ts` | `MidiInputEvent` (decoded, sequenced, consumed once). |

### Timelines and identity

- Performance positions are whole notes from the start of the **unfolded** performance.
  `MeasureOccurrence.index` is both the performance-order index and the measure index in
  `ScorePackage.renderXml`.
- `SourceNote.id` (document order) ≠ `PerformedNote.index` (one per occurrence) ≠ renderer
  graphic ids. The renderer maps graphics → `PerformedNote.index`.
- `PerformedNote.midi` is the sounding pitch (ottava already resolved, see DECISIONS M1).

## Modules

### core/import (worker-safe)
Views use `createImportClient()` (`inspect` → `build`, with `signal` and `onProgress`; one job
at a time; abort terminates the worker and rejects once with `canceled`, nothing delivered
afterwards), which drives `src/workers/import.worker.ts`. The pure `inspectSource(file)` and
`buildScorePackage(file, {candidate, partIds})` → `{package: {model, renderXml}, summary,
source}` run directly in tests. Helpers: `applyHandAssignment`, `withUserTempo`,
`summarizeImport`. Pipeline: `source.ts` (format detection: zip / .mxl container / opus,
encoding, order-preserving XML, timewise) → `candidates.ts` (scores, parts, selection
validation) → `read/part.ts` (MusicXML cursor model per part) → `skeleton.ts` (staves, bar
lengths) → `navigation.ts` (D.C./D.S./To Coda/Fine plan from sound attributes, signs and words
of all parts) → `repeats.ts` (unfold to performance order, following the plan) → `ottava.ts` (scope) → `sourceNotes.ts`
(written vs sounding pitch, accidental context, clef, velocity) → `performance.ts` (performed
notes, tie chains, roll groups) → `tempoMap.ts` → `rolls.ts` → `hands.ts` → `events.ts` (key,
meter, clef maps, pedals, dynamics) → `issues.ts` (unsupported regions, timing issues) →
`renderXml.ts` / `summary.ts` / `version.ts`. Positions are exact whole notes; after a repeat
jump, context is what the written score states at the jump target. renderXml has one
`<measure>` per occurrence numbered 1…N, and rewrites octave-shift markup so OSMD engraves
exactly the model's scope. Navigation is display-only in renderXml: a followed instruction
appears only on the occurrence where it acts, signs once, `<sound>` navigation attributes are
dropped and navigation words carry U+2060 so OSMD builds no repetitions of its own. Limits: `limits.ts` (size, expansion, entries); no DTD, external
entities or network references. Fixtures: `tests/fixtures/scores/` (24) and
`generateLongScore(500)`; reference-piece facts are tested when the private fixture is present.

### core/engine (pure)
Framework-free state machine; never reads clocks, timers or MIDI. The session passes human
MIDI events and `now` (performance.now() timebase). Details and state diagram:
`src/core/engine/README.md`.
- `buildTimeline(model, {hands, range, multiplier, tempo?, reattackHeldAtStart?})` → learner onset groups (distinct
  pitches, ties excluded, loop-start boundary reattacks), measures, automatic positions,
  expected attack span / notated duration, blockers, comparison context. Once per selection.
  An unscored Repeat lead-in sets `reattackHeldAtStart: false` in the learner and guide timelines
  and in the automatic playback builder's learner-unison check (U38).
- `PracticeEngine`: `input(ev)` (consumed once by seq; positive Note On is the only attack),
  `tick(now)` / `nextDeadline()`, hints (`requestHint`, `dismissHint`), `setKeyboardVisible`,
  `recordPersistentLabelExposure`, lifecycle (`markPrepared`, `pause`, `resume`, `interrupt`,
  `restart`, `seek`, `reconfigure`, `updateSettings`), readonly `state` + `drainEvents()`.
- Transport seam: gates = `transportGates(timeline)`; `onGateReached(i)` →
  `transportArrived(i)`; event `input-complete {group}` → `transport.releaseGate(group)`.
  Free (both-hands) mode ignores arrivals.
- Labels: `temporaryLabelOpacity(now)` per frame (eased, active time); the renderer combines it
  with persistent labels by max. `fadeOutOpacity` is the shared smoothstep fade curve.
- Records: `attempt-ended {AttemptRecord}` (kind scored | reading, both with per-group outcomes), `measure`, `abandon`,
  `attempt-discarded` (ended before the first press). `exposure-reset` → re-report visible
  labels. The session calls `markPrepared` only after persistent-label fades finish.
- Scored: Preparing → Ready (prepared, keys and 64/66 released, hint fades done) → Running
  (first fresh press, even wrong) → Completed → restart. Reading: Running ⇄ Paused.
- `PlayFollower` (`follow.ts`, P12): the follower of Follow over the same `Timeline`, beside
  the unchanged engine. `input(ev)`, `tick(now)` / `nextDeadline()` (the patience release),
  `transportArrived(i, now)`, `pause` / `resume` (paused time never counts), `seek`,
  `reconfigure(timeline, now)` (speed or hands), `resetPhysical`, readonly `state` +
  `drainEvents()`: `release {group, reason: complete | skipped | patience}` →
  `transport.releaseGate(group)`, `accepted`, `wrong`, `advanced`, `key`, `finished`. A gate is
  released when its group was played, when a press matches one of the next 2 groups (skipped
  gates released in order), or `patienceMs(timeline, i)` (onset-to-next-onset time clamped to
  300–2000 ms, 1000 ms for the last group) after both the arrival and a press. Records nothing.

Strict transport (rhythm mode, P13): `transport: 'strict'` with `rhythm.toleranceMs` (default
`DEFAULT_RHYTHM_TOLERANCE_MS` = 150 ms, real time). The session starts the attempt clock with
`engine.startRunning(t0)` at the end of its count-in, releases every transport gate the moment
the transport reaches it and reports `transportArrived(i, at)`; the engine judges each onset
group against that scheduled time: presses more than the tolerance before arrival are `'early'`
wrong attacks; completed groups advance at once and record `offsetMs` (completion − arrival,
negative = early); incomplete groups close at arrival + tolerance with a `missed` event and the
next group becomes current; a press of the just-missed group within the tolerance is a gentle
`'late'` slip, not a wrong attack. A press for a later group whose scheduled time is within the
tolerance waits for that group (nearest first, P17), so a slip on a fast run costs only the
groups slipped. Presses in Ready are not judged, except those from the downbeat minus the
tolerance on: the session hands them back after the count-in with `engine.countInPress(note,
time)`, judged at their own time like any press, so an early first downbeat counts with its
negative offset. Strict records use `matchingRules` `strict-v1-tol-<n>ms` and
carry `rhythm`, `missedGroups` and per-group `offsetMs` / `missed`; they pass only with no wrong
attack, no missed group and every group within the tolerance. Close times come
from injected arrivals and surface through `nextDeadline()`. Strict `input-complete` also
carries `onsetOffsetMs`, the first matched attack's offset, for live timing feedback. The
record stores the completion offset for grading and an optional differing first-attack
offset for the review strip. The event never releases a gate in strict mode.

### core/audio (worker-safe)
The audio score follower behind Follow on an acoustic piano (DECISIONS P14 spike, P15
wiring, P16 redesign). It follows attacks, not time: the position moves only when something is
struck that fits an onset group near it, so a player who stops is waited for and no tempo is
involved. `features.ts` (`SemitoneAnalyzer`) turns mono samples into the energy of each piano
semitone every 10 ms (4096-sample frames under a skewed window; in-repo radix-2 FFT);
`templates.ts` lists the score's onset groups (`attackGroups(model, hands?)`, the practice
timeline's groups for both hands, or for one hand by the timeline's `n.hand` rule, P22) and the semitone energies each adds when struck (`attackTemplates`);
`matcher.ts` (`OnsetMatcher`) opens an event when semitones rise over their baselines, scores it
against the groups near the position (cosine of the observed rise with each group's expected
rise over the sound already there) and keeps a Viterbi score per position, so skipped notes,
chords arriving in parts, a jump of a few bars and getting lost are one mechanism; `index.ts`
exposes `createAudioFollower(model, { hands? })` (`push(samples, sampleRate, time)` → the group heard last,
its position in whole notes and a confidence; `reset(position)`; `listen()`).
`groups.ts` (`groupReached(timeline, position)`) is the only part the session bundles.
`protocol.ts` + `workerHandler.ts` are the worker side (`workers/follower.worker.ts` binds
them): configure / reset / pause / resume / samples in, an estimate out each time the group
heard last changes. `evaluate.ts` and `testkit.ts` are test support. Pure: no DOM, no Web Audio.

### app/audio
`micFollower.ts` is the browser side of the microphone follower (P15): `getUserMedia` (no echo
cancellation, noise suppression or gain control; one channel) → an `AudioContext` with the
AudioWorklet `public/mic-processor.js` (512-sample blocks posted to the main thread) → the
follower worker; estimates reach the session's `#onMicEstimate`, a capture that ends by itself
or a failing worker reaches `#onMicLost`. `SessionDeps.createMicFollower` injects it (tests use
a fake), with the selected hand (P22: one hand follows that hand's groups);
`microphoneSupported()` (`SessionDeps.micSupported`) says whether the browser can open one at
all. The session owns its lifetime: opened on Start in a Follow that uses the
microphone (only without a piano input, P37), closed when
Follow is left (also while it still opens), the hands change or the source changes.

### core/naming
`labelFor(note, naming)` → `{name, accidental, octave, text}` from the resolved sounding pitch
(ottava applied once); `labelForMidi` for bare keys; `maxLabelWidthChars` sizes reserved label
room. Order: simplify spelling → choose accidental (effective vs contextual via
`contextAlter`) → fixed do. Naming never changes pitch, matching or eligibility.
Eligibility: `isPersistentLabelVisible(note{midi, clef, tieContinuation}, labels)` — strict
sounding-MIDI comparisons, OR of enabled conditions, rule per governing clef (unknown clef = both
off); tie continuations only with `labels.tiedContinuations` (default off, U69).
Settings helpers: `validateRule`, `describeRule`, `sampleRule`, `parseSpelling` /
`formatSpelling`, `clefDisplayName`. Full API in `src/core/naming/README.md`.

### Performance recordings

Practice loads `views/recordings` on demand. The recorder subscribes to the
selected MIDI input and opens a separate, unmonitored Web Audio capture graph. Its worklet
transfers interleaved 16-bit PCM blocks. Stop writes a standard MIDI track and WAV header and
sends the played attacks to a worker for comparison with the selected practice timeline.
`core/recording` owns the file encoders and ordered, chord-aware note matching. Timing and
velocity are preserved in the MIDI file. They do not affect this pitch score.

IndexedDB v4 (`core/storage/recordings.ts`) stores a take as `recordings[id]` (metadata, the only
store lists read), `recordingFiles[id]` (`{ midi, type, blocks, bytes }`) and one
`recordingBlocks[[id, i]]` record per 4 MiB block of the WAV file, so no stored value comes near
Chrome's 127 MiB limit. Save reads the captured Blob one block at a time and writes one block per
transaction under a `pendingRecordings[id]` marker; the last transaction checks every block is
there, writes the files record and the metadata, and removes the marker, so a take is listed only
when complete. A failed save removes its blocks at once; one cut short by a closed page is removed
on a later open (marker older than an hour). Deleting marks the metadata `discardedAt`
(`discardRecordings`, one small transaction), which takes the takes out of lists, sums and backups;
`restoreRecordings` clears it, and `removeDiscardedRecordings` removes metadata, files record and
blocks (key range) of those still marked. A later open removes what was marked over ten minutes ago.
`views/recordings/discard.ts` (U164) owns the time to undo: one batch, its own timer and one toast
with Undo for all that was discarded meanwhile, a take discarded while recording held in memory
included. Takes saved by schema 3 kept every block inline (`recordingFiles[id] = { midi,
audio: ArrayBuffer[] }`): the version 4 upgrade moves them to blocks in the upgrade transaction,
and a take it cannot convert keeps that shape, which every reader still accepts. History reads
metadata for ranking; opening a take reads its blocks by key range into one Blob (one copy) for
the player. Download builds the ZIP only when pressed, as a Blob that refers to the take's own
Blobs between stored-entry headers (no second copy), and releases its URL after the download has
started. Its filename starts with the capture start (`createdAt`) in ISO 8601 with the stored local offset
(`startUtcOffsetMinutes`), then the piece (U165). Dates and times shown are written by `i18n/dates`. Older takes use UTC. A take stores its passage range (`passageRange`,
null = whole piece) and its label is formatted when shown, in the current language, with the
score of the take's version; takes saved before that, or whose score is gone, show the label they
stored. A take warns once at 20 minutes and stops by itself at 60 (saved as if Stop was pressed),
timed by the recorder's elapsed-time poll, never in the MIDI path; the 4 GB WAV guard stays. The
header, or a footer on portrait phones, hosts the live timer, Stop and Discard only while a take
is in progress (a take starts from the menus' Record performance, and their Stop and Discard recording end it too) while the recorder keeps
ownership of both input streams. `useRecordingDialog` owns that place and the recorder's phase
(`busy`: opening, recording or saving; `showing`: a take or the saved pill is in the place; `isOpen`:
everything but the pill, which closes the menu). With `settings.recording` set and a piano connected
it starts a one-tap take (D20): an AudioContext resumed inside the tap goes to the lazily loaded
`Recorder`, which opens the remembered input (`openPerformanceInput` with `remembered`, checked with
`core/recording/input`) and begins at once, or falls back to the setup sheet with the reason. A take
that starts from the sheet writes `settings.recording`. After Stop, `SavedTakePill` draws the pill into
the same place; its player holds a blob URL of the take's audio from the first Listen until the pill
goes (closed, another take, the score starting, the screen left). Full backups include takes unless the player turns off "Include
recordings" (see core/storage) and merge immutable recordings by ID. Deleting a score leaves its
recorded performances available in the list of all takes (`RecordingHistory` without a piece). `RecordingList`
is that list without its sheet; `RecordingsSheet` (in the Library's and Practice's bundles) loads it for one
piece. `playedThrough` (`core/recording/performance`) tells whether the playing reached both ends of its
passage; the scoring worker computes it and the take stores it. For takes saved before, `completeness.ts`
works it out from their MIDI file and their score's version, only where the take's own score comes out again.

### core/midi and core/playback
core/midi: `MidiAdapter` (main thread) runs `onmidimessage` → `MidiDecoder` (monotonic `seq`,
Note On velocity 0 = release, real-time bytes skipped) → `PhysicalState` (held keys per
channel, separate from sustained sound) → subscribers, in order. `statechange` yields input /
output disconnected / reconnected events; ports are remembered by id, then name
(`applyRememberedRoute`). Setup tools: `HintPedalLearner` / `Confirmation` / `Trigger` (one hint
per press, hysteresis, inversion), `runEchoTest` (three-note probe, also the audible test
notes) and `gradedAccompanimentAllowed` (verified output + echo `none`).
core/playback: `buildPerformance(model, {hands, range, accompanimentLevel, sendPedals,
listenFilter})` → the automatic part's note on/off and pedal (CC 64/66/67) events at written
positions plus 1× roll offsets; tie chains are one attack, learner unisons suppressed,
automatic unisons merged. `createTransport` is the one lookahead scheduler (100 ms) with an
injected clock and timers: gates = learner group positions, nothing past an unreleased gate,
`onGateReached(i)` then hold, `releaseGate(i)` re-anchors without burst or replay, live
`setMultiplier`, `msUntilGate` feeds the engine's `transportEta`. Backends share
`OutputBackend`: `MidiOutputBackend` (ownership counted per channel+note, releases deferred
while the human holds that pitch on a route verified echo-free, cleanup on the app channel only) and the lazily imported
browser-audio backend (one AudioContext, Salamander bank ≤ 32 MiB decoded, synth fallback).
The metronome is clicks scheduled by the same transport (free mode: click-only transport
started at the first press). `AppSettings.metronome` (P20): `enabled` (default off) is the click in
Listen, Wait and Follow; `keepTime` (default on, absent in older stored
settings = on) is the click in a Keep time attempt after its count-in; the count-in always clicks.
`outputId` defaults to system audio. A separately selected browser audio output uses its own
context so Listen, accompaniment, and monitoring can continue using their own destinations. The
picker shows only where Web Audio can select an output (`AudioContext.setSinkId`). A browser that
hides its outputs until the site has media permission gets a Show audio outputs button; only that
tap asks (`selectAudioOutput`, or the microphone once, stopped at once).
Session wiring notes: `src/core/playback/README.md`.

### core/history and core/storage
history (pure, worker-safe): `ingestAttempt` / `ingestAbandon` fold engine records
(`AttemptRecord`, `MeasureTraversal`, `AbandonEvent`) into a per-piece `PieceHistory`
{bars, suggestions, abandons}; `selectSuggestions` builds up to three display-ready suggestions
plus Improved; `results` / `buildScorecard` summarize attempts per comparison context (best
clean unassisted vs assisted, streak). Bars are keyed (measureContextKey, occ); only complete
traversals enter the window of five.
storage (IndexedDB "pianissimo" v4, idb): `openStorage()` → `PianissimoStorage`. Stores:
pieces, sources, packages (both keyed by scoreVersionId), settings, attempts (indexes pieceId,
contextKey), measureHistory, suggestionState, abandonEvents, layoutCache (+meta, LRU by bytes
and count), libraryState, and the takes' recordings, recordingFiles, recordingBlocks (key
`[recordingId, blockIndex]`) and pendingRecordings (see Performance recordings). An upgrade that
another tab blocks (it keeps an older version open) calls `StorageOptions.onBlocked`, and
`app/services` shows a notice asking to close the other tab until the open goes on; this tab
closes its own connection when a newer version asks. `commitImport` writes source + package +
piece in one transaction; `loadSettings` merges stored settings over `DEFAULT_SETTINGS` field by
field (`normalizeSettings`).
Practice records: the session calls `storage.history.queueAttempt` / `queueAbandon` (O(1),
never in the MIDI path); the `HistoryWriter` flushes on idle, `pagehide` and visibility-hidden
(`attachLifecycle()` once), ingests through core/history and writes attempts + changed
history in one transaction. Views call `loadSuggestions(pieceId, sessionDismissals)` and
`loadResults(pieceId)`. Export/restore (`*.pianissimo.zip`, format 1, fflate, lazily
imported): manifest + one JSON per store + sources/*.bin + packages/*.json + recordings.json and
recordings/<id>.mid / recordings/<id>.wav.<i> (stored parts of at most 4 MiB), layout cache
excluded. `exportAll({ includeRecordings })` returns a Blob assembled from parts (never one array
of the archive; each audio block is released once added) that the download hands to the browser
without copying; with recordings off the manifest carries `recordingsExcluded: true` and no
recording entry is written. Export refuses (`BackupError` 'too-large', a message suggesting to
turn recordings off) a backup that restore would refuse for its size (512 MiB per entry, 2 GiB in
all, 50 000 entries), checked from the takes' stored sizes before any audio is read. Restore takes
the picked File and reads it by slices (its own central-directory reader): it validates
everything first (`BackupError`, nothing written on failure), merges library, results, history
and settings by id in one transaction, then restores each take in its own transactions, reading
its audio a block at a time; a take that cannot be stored is skipped and reported
(`RestoreReport.recordings` added / skipped as already present / failed, plus a warning) and
never undoes the rest. Settings restore keeps this device's MIDI route, metronome output device
and recording input unless `route: 'backup'`. Details: `src/core/storage/README.md`.

Rhythm mode results (core/history, views/results, app/session/corrections): `timingAccuracy(record)`
summarizes a strict record's per-group `offsetMs` / `missed` against `rhythm.toleranceMs` (on
time, early, late, missed, mean and mean absolute offset). A clean unassisted completion needs
zero missed groups in every context, and strict clean runs rank by mean absolute offset.
`buildScorecard` gives completed strict records `timing: 'rhythm'` and timing rows (on-time
groups, early, late, missed, average offset, timing window) instead of completion, expected and
difference rows. Progress names a strict context "Keep time · ±N ms". Teacher
corrections add a `'missed'` mark (`CorrectionMark.kind`) and judge lateness against the
record's tolerance for strict records.

### render/
`OsmdRenderer.prepare(RenderInput, {labels: {maxChars, room}})` → `PreparedLayout` (plain JSON,
cacheable via `LayoutCache` / `prepareLayout`; `storeLayoutCache` adapts the IndexedDB store).
Pipeline: dynamic `import('opensheetmusicdisplay')` → one-system engraving
(`SheetMaximumWidth` lifted) → extraction (graphic notes, measure anchors, staves, ottava
brackets, glyph groups, obstacle boxes) → `mapNotes` (occ, staff, voice, onset, midi, grace;
relaxed passes reported) → `layoutLabels` (worst-case box beside every notehead: right / left /
stagger / stack / callout; widen both staves and re-engrave when > 0.5 % need callouts, at most
3 engravings; label room `'hints'` for Labels Off: spacing 1.0, one engraving, labels clear of
their own group only, callouts may cover a mark, DECISIONS R3 revised) → sanitize (allow-list; black → currentColor) → measure-range segments (≥ 400 px,
a measure or two; crossing marks copied and clipped, touching neighbors not, PF6) → the full
tree is discarded. Label boxes and
measure-number boxes are measured once with canvas `measureText` in the strip font
(`labels/metrics.ts`, session cache; 0.62 em estimate without canvas; `PrepareOptions.textMeasurer`
for tests). Measure numbers are placed first (`labels/numbers.ts`: raised in 3 px steps past
engraved marks and earlier numbers) and are label obstacles.
`StripView(host, layout, opts)` mounts the viewport ± one viewport plus an LRU of 4 detached
segments; cursor fixed at 1/3 with transform-only score scrolling, including beyond the score
ends. CSS zoom is capped so the grand staff fits vertically and the fixed signatures plus their
fade stay left of the cursor. Overlays are class/attribute writes batched in one rAF, O(changed notes).
Label text nodes exist only while opacity > 0; visible ones are reported via
`onVisibleLabels`. Also: passage band with handles, tap selection and ✕ clear (U5), ottava
emphasis + offscreen reminder, opening clef/key/meter that glide with the strip and pin to the
left edge, with aligned staff lines and an opacity mask for passing notation,
cursor timing tint (`setTimingCue`), theme via `--score-*` tokens (U8). Learner targets and accepted notes set the notehead color (U121).
A change of label room swaps the engraving with a glide (`shared/respace.ts`: the wider engraving cut into onset
columns that move from the old view's places to the new view's, cursor note anchored; Practice
keeps the old view until the new layout is ready). The glide follows the live view frame during
playback. Rapid reversals await `whenRespaced()` before replacing the view, with stale requests
discarded (U63). The portrait cursor shares the glide's eased progress between the layouts'
live cursor geometry, with CSS seek transitions disabled during playback/respacing (U64).
Full API: `src/render/README.md`. Browser tests:
`tests/e2e/render-*.spec.ts` with the harness in `tests/harness/` (not in the production build).

#### render/keyboard
`<KeyboardGuide targets held wrong rollDirection showFingering visible opacity fadeMs naming/>`
(Preact, display-only; `index.ts`). Targets are `{midi, hand, label?, accepted, fingering?}`;
feed it the engine's accepted pitches / held keys / held wrong keys per onset group, and pass
`label` only when note names should show. Enlarged window = targets snapped to whole octaves
(≥ 2, never cropped) + an 88-key locator; bars wait on a playing line; chips carry an L/R
letter, the caller's name and score fingering. Key states are shape-coded: accepted = tint +
green outline + ✓; held = pressed shadow + dot; wrong = red + ✕ (edge badge if off-window).
Fixed height, width from its container. Hide with `visible=false` and keep it mounted for
`fadeMs` (fade, U3). Root is `role="img"` with a text summary. Tokens only. Recording
"keyboard-assisted" is the session's job (engine `setKeyboardVisible`).

### app/ and views/
`app/App.tsx` is the shell: current view from `app/views.ts`, compact app bar (non-practice
views), toasts, Settings overlay. `views.ts` is the only place mapping a `ViewName` (`library`,
`practice`) to a component: `component` (static) or `load: () =>
import(...)` (lazy), and `chrome: 'bar' | 'none'` ('none' gives Practice the whole viewport). Navigation is `app/navigation.ts`;
Settings is an overlay over the mounted view, so the score and passage are never lost.
`app/state.ts` holds coarse signals only: `settings` (`updateSettings(patch)`, immutable deep
merge, per-clef rules merged per key), `connectionStatus`, `notices` (`pushNotice`; a `brief` notice is the
small capsule that `NoticeArea` lays over the connection chip, `[data-connection-chip]`, or under the header,
`[data-app-header]`, and removes after `BRIEF_MS`; toasts have no close button and are swiped away, U166). Storage
plugs in via `await setSettingsPersistence({load, save})` (debounced saves, flushed on
pagehide). Label changes go through `applyLabelSettings(next)`, which runs
`onBeforeApplyLabels` hooks first (the practice session registers one that interrupts a scored
attempt); naming-only changes use `updateSettings` and never interrupt.
`app/features.ts`: `getFeatures()` (MIDI, audio, module workers, IndexedDB, persist(), wake
lock, each with an explanation). `app/wakeLock.ts`: `wakeLock.hold(owner)` / `drop(owner)`.
`views/settings`: the four Settings tabs (U143; Note names rules staged in a draft, applied explicitly).
`views/connection`: the piano setup, a lazy chunk mounted only while Piano and sound is shown.
`views/shared`: ConnectionChip, `suggestions/`, test helpers. `ui/`: tokens (motion, type,
spacing, elevation), controls, fades (`useFadePresence`), `WrongNoteFlash` (stationary damage
vignette, U2/U30), `HandToggles` (U4), `ScoreOverview` + `LoopSteppers` (U6), `TempoControl` (U7),
`BeatUnitIcon`. Props: `src/ui/README.md`.
`app/services.ts`: lazily created singletons. `getStorage()` opens IndexedDB once and attaches
the history lifecycle, then awaits `app/initialPieces.ensureInitialPieces`. That module fetches
twelve bundled MusicXML archives for a new library or the ten new scores for an existing
library and builds them through the existing import worker. The installation-local
`libraryState` markers distinguish first use from the one-time expansion. An expansion
appends only missing score versions and keeps existing records and packages intact.
Source, package, piece, and marker writes are atomic. Deletion never resets either marker.
Bootstrap failure leaves storage
usable with a notice and retries on reload. `getMidiService()` / `getMidi()` own the one `MidiAdapter` and never
request access by themselves. `startServices()` (from `boot.ts`) loads settings (memory
fallback with a notice), then reconnects a remembered route only when permission is already
'granted'. `MidiService` publishes a snapshot (access, permission, ports, selected input /
output) that drives `connectionStatus`, remembers routes, auto-selects a remembered port when
it appears and coalesces disconnect notices. The practice session uses `onRoute(fn)`
(synchronous) to interrupt on `*-disconnected` and waits for `adapter.physical.isClean()` after
`input-reconnected`; it registers `registerSoundOwner(() => transport.stopSound())` so Stop
sound (CC 123, app channel only) covers its notes.
`views/connection`: three step cards (piano = access + input; playback = output + test notes
that double as the echo probe + accompaniment options; hint pedal) and a frame-throttled live
panel (`LiveMonitor`, O(1) per event).
`views/library` (bundled, first screen; never imports OSMD, samples or the `core/import` index):
`LibraryModel` (piece list from `listPieces`, open → `openPractice`, delete, clear history,
export, restore + settings reload) and `ImportFlow` (read → `inspect` → score/part choice when
needed → `build` → summary review, skipped when `needsNoAnswer` (L12) → `commitImport` → `requestPersistentStorage` once). Each async
step carries a job token; cancel/close bump it and dispose the client, so a canceled job never
updates the UI. `review.ts` applies `applyHandAssignment` / `withUserTempo` and re-checks
`summarizeImport(...).readiness`; only ready packages are stored (L1). The Continue card alone reads the
piece's suggestions (`PieceSuggestionsModel`, one "Work on bars …" button → `openPractice` preset); no row
reads attempts. Options → Progress… opens the piece's Progress (below). `openings.ts` (U157) keeps each row's
ground and the opening it draws in `localStorage` and reads missing openings from their packages one at a
time, after the list shows.
The Library shows compact ordinary rows, with a Continue practice feature only for a recent
piece with a saved resume position or active Repeat. Stored ranges are normalized before
labeling.
Import review keeps the ready summary compact and technical checks under Import details;
blockers and consequential warnings remain visible. Saving navigates to
Practice paused; the later Start/Play gesture owns audio and microphone activation. Duplicate
imports offer Open existing piece and a secondary Add another copy with shared reviewed metadata.
Search (L13) filters the piece records only (`search.ts`). `ConnectPianoCard` is the first-time piano setup (U149): `MidiService.connectOnBoot` and `selectPiano`.
Dependencies are injectable via `LibraryDeps` (tests: `views/library/testkit.ts`). Export and
restore are in Settings → Data (`views/settings/BackupSection`, its own `LibraryModel`); the
Library refreshes its list when Settings close (L7). When there are takes, Backup shows an
"Include recordings" switch (on by default) with their number and total size
(`LibraryModel.recordings` from `storage.recordingsSummary()`, `formatBytes`), and the restore
report lists takes with the other stores (`describeRestore`).
`app/session/` (framework-free, all dependencies injected): `PracticeSession` owns one piece's
practice. Each human MIDI event → `MidiOutputBackend.humanInput` → `engine.input` → engine events
drained (`input-complete` → `transport.releaseGate`, records → `storage.history.queue*`). Visual
changes wait for one rAF frame (strip targets, accepted notes, wrong marker, ottava emphasis,
cursor, flash, label opacity = max(temporary, persistent), and keyboard guide).
The view subscribes to four stores: `ui` (coarse), `progress`, `feedback`, `guide` (each at most
once per frame). All practice uses a gated musical transport (P9), silent for both hands and
playing the automatic part for one hand. Where it may sound is asked at Start (`ui.otherHand`,
`OtherHandSheet`, U149) while the route is not verified echo-free. It runs from Ready, holds at missing learner attacks,
and preserves the first-human-press attempt clock. Listen has no engine attempt. Feedback
includes an icon-only octave direction for same-pitch-class errors (U30); no generic error text.
Hiding the page saves progress without stopping playback (P10). Leaving the view ends a running
attempt as a user stop and a paused reading pass as `'suspend'`, so both are recorded (P18). A
Start that was paused while its sounds loaded starts nothing (`#startGen`, P19). Preparation calls `markPrepared`
once the strip is attached and persistent-label fades have finished. `practiceModel` applies a user
tempo; `createPieceSaver` debounces piece updates.
Starting playback resolves the optional `StripSink.browsedPosition()` to an exact seek and
calls `returnToCurrent()` to restore following, including after asynchronous sound loading.
The strip reports the nearest onset beneath its fixed cursor while browsing. Browsing cannot go
back past the piece's first cursor stop (`clampTranslate`, U96); forward it stops with the content's
right edge under the cursor line. The page reports
no alternate position because its cursor moves with the notation. Explicit accepted cursor
seeks also end browsing (U52). Existing Repeat seek and Listen range rules still apply.
A strip browse that begins while something plays holds the sound (`browseStarted`, the attempt
is discarded, U41) and its release (`StripOptions.onBrowseRelease` → `browseReleased`: the last
finger up or canceled, 250 ms after the last wheel event, or a handle drag that scrolled) runs
that same Start path; the page layout's scroll pauses nothing (U95). A loop changed while
Repeat plays keeps playing from the reached position inside the new loop, else its start (U94).
`ui.canRestartLoop` exposes a playable Repeat loop while playback is stopped, including
before the first pass. Practice floats Restart loop at the score's bottom left. It shares the
pill shape of Return to current position and uses a neutral fill. `session.restartLoop()`
restores score following and uses the Start path for a fresh pass or Listen at the selection
boundary (U118).
Modes (U141): `PracticeMode` (`core/model/practice.ts`) is `'listen' | 'wait' | 'time' | 'follow'`,
the learner's choice, published as `ui.mode` and changed only by `PracticeSession.setMode(mode)`,
which saves `PieceRecord.mode`. It ends what the old mode does (recorded by Wait and Keep time),
keeps the cursor at the next playable onset and starts nothing. Hands are `LearnerHands` (both, left
or right) in every mode: the ones the learner plays or, in Listen, hears (`listenFilter`). Listen and
Follow record nothing and never save the resume position. `openingMode(piece, env)` derives the mode
of older records (`rhythm`, `lastHands: 'none'`), which nothing writes any more. A piano that goes
away only blocks Start in Wait and Keep time (`startPlan`).
Follow (P12): Start builds a
`#play` slot beside the engine, like Listen's: a gated transport over the whole piece (silent
for both hands, the automatic part for one) and a `PlayFollower`. Human events then go to the
follower instead of the engine (`#onMidi`), follower `release` events release transport gates,
`onGateReached` → `follower.transportArrived`, and the frame draws the follower's group, the
transport position, the timing cue and the guide. `ui.activity` is
`'playing'`, `startAction` `'play'`; the engine waits paused. Repeat is put away meanwhile and comes
back as it was when Follow is left.
For MIDI input, `PerformanceTiming` compares the first attacks of consecutive recognized
groups to their written gap at the selected speed (U111). Both score layouts show the same
transient cue as Keep time.
`hints.showTimingCues` gates the live direction and reserved row in both session frame paths. The renderer derives the label and cursor tint from that direction. Older settings default to enabled.
Ordinary Practice and gated Repeat use the same comparison on the first accepted pitch of
each group (U129). A correct pitch rejected as early shows Rushing immediately. The session
clears the cue on a phase change or new traversal and schedules its expiry even while the
transport waits at a gate.
What it follows (P22, P37): without a piano input the microphone; with one, always the keys
(`ui.follow`). Releases that move musical time at once (an early or skipping press, several groups
heard) keep their distance in `CursorCatchUp`, and only the drawn cursor glides across it (U162). While the microphone
follows, the transport is silent for any hand (no accompaniment, no click) and MIDI notes never
reach the follower; a change of source pauses a started Follow (`#syncFollowSource`) and
the next Start rebuilds it.
Repeat mode across reloads (U98): `PieceRecord.repeatOpen` (optional; absent = closed) is saved
by the session whenever Repeat opens or closes (at once, with loop edits, the Repeat-until target
and the ladder settings; never from the MIDI input path) and read by `PracticeScreen`, which
opens the session with `repeat: true` over `lastPassage`, paused at the loop start, instead of
from the resume position. A preset's opening state is saved on the piece when it opens, and
`startRouter` does not apply a `history.state` preset at boot, so a reload reopens the stored
state. Results, corrections and the streak are never stored.
Speed ladder (U77, U124): the piece's `ladder` (`LadderSettings { goal, step }`, null = off) is
stored on `PieceRecord` and opened into `PracticeSession`, which publishes `ui.ladder`
(`{ goal, step, done }`). The pure rules are in `app/session/ladder.ts`. After each completed
scored attempt while Repeat is open, meeting the consecutive-pass target (`repeatTarget ?? 3`)
climbs one step on the 5% grid toward the goal (or ends the climb at the goal). A failed pass
resets the clean streak at the current speed. Automatic steps take effect at the Repeat reset
through the ordinary speed-change path. `AttemptSummary.ladder` tells the result card what
happened. The options
default to a 100% goal (U116). Selecting it at or above 100% makes `setLadder` start a fresh
ladder at 75% through the manual tempo-change path.
Keep time (P13, U78): every Start is a scored attempt on the engine's strict transport,
with `rhythm.toleranceMs` from `AppSettings.rhythm`. Outside Repeat, the attempt runs from
the playable onset at the cursor to the piece end (U128). The strict engine, count-in,
accompaniment, and results use that passage. In Repeat they use the selected loop. A header
seek ends the current attempt and positions the paused cursor on the whole score.
When the engine is Ready the session counts in through the metronome sink and
publishes the number of clicks left in `ui.countIn`. The plan (`countIn.ts`, U124) fits up to
one bar into five seconds. If fewer than two whole beats fit and the bar is too long, it uses
two subdivisions of the entry beat. The count-in always clicks. A Metronome switch turned off
meanwhile cancels the sink, so the session schedules the remaining clicks again. The
attempt itself clicks per `metronome.keepTime` (P20; `app/session/metronome.ts`: `metronomeScope`,
`metronomeOn`, `metronomePatch`; `ui.metronomeScope` names the switch the current mode uses and
`ui.metronomeMuted` is true in Follow while the microphone follows). Start creates the shared
AudioContext synchronously inside the tap when it will click (iPadOS gesture rule); at the end it calls `engine.startRunning(t)` and
`transport.play(t)` with one timestamp after releasing every gate, so the music never holds. The
transport reports each arrival (`transportArrived`); the engine judges, closes missed groups and
builds the record. The session can show a soft wash for a missed group and tracks drift in
`TimingDrift` (U107, U111, U113). A pitch index prepared before the count-in supports matches up
to one second from the playhead. The session sends the direction and enabled state to
`StripSink.setTimingCue` in the animation frame. The shared cue follows the viewport
x-coordinate of the playhead, clamped at the edges (U123). In the strip, the cue sits just
above the full engraving or uses the reserved row when the engraving reaches the top edge.
In page view, the active system's staves rest in the middle of the viewport and the cue sits
just above that system (U146). The cursor shares the cue's color and returns to its standard tint when the cue
clears. The result card's timing line comes from `timingAccuracy`.
The lazy Details view uses `buildTimingReview` on the completed record and its timeline.
`ResultDetails` merges bars with timing deviations into the ranked correction excerpts by
occurrence, putting timing-only bars afterward. `TimingBarPlot` uses the excerpt's engraving
anchors for the onset plot under the score. A miss breaks the plot line and appears as a cross.
All affected bars are listed, and later excerpts wait until visible to build their notation.
A pass within the near-beat window has a folded timing summary beneath the pass facts.

During Keep time (U112), the session converts each playable bar in the selected passage into
an activity window using the tempo map and the actual bar and loop boundaries. A fresh key
press counts for the bar it lands in and, when it comes up to the scoring tolerance before a
barline, for the next bar too (an early downbeat; the count-in's last stretch counts for the
first bar). The windows move with the transport when a late timer or a stall shifts the music
(`Transport.shiftMs`), as the live timing cue does. A bar with no required attacks has no
silence check. The shared session timer stops playback a short grace (100 ms) after any silent
playable bar's end, so a key stamped before the barline but delivered late still counts.
Repeat also checks for any written learner pitch in the opening two bars without scoring
tolerance. A one-bar loop gets its second bar on the next traversal. The session holds early
scoring completion while an unresolved check could still stop playback, so an automatic stop
leaves the previous result and does not add a pass to history. Any other way of leaving the
pass (pause, seek, selection or mode change, a lost input or output, Again, leaving the view)
records the held pass first, unless the Repeat opening check is still pending: with no sign of a
player it is dropped as the automatic stop drops it. On the next downbeat the session hides the previous pass's
score marks in both layouts. The same marks return with the previous review after a stop.

Playback (P27) is an opt-in app setting in `AppSettings.rhythm.scorePlayback`. The session
builds both parts with the Listen performance builder on the strict transport. The same transport
runs the optional metronome and reports each learner gate to the engine. It starts on the downbeat
after the count-in. Output uses the existing graded route check. The switch replaces the scheduled score events
in the existing transport and releases its old notes.
The count-in, metronome, clock, and grading continue. The engine adds `scorePlayback: true` to
the comparison context for passes that use it above 0% (at 0% Playback counts as off, also for
the Start plan's output check). Result and per-measure keys append the playback
mode only when it is present, preserving existing keys.

The Playback volume slider slides open under its switch in both menu layouts.
The transport applies the current volume to upcoming full-score attacks and omits score events at 0%.
The review keeps the completed record, matching timeline, and recent records for that comparison
context, so a later interrupted repeat can never replace the pass shown on the card.

Keep time has no Repeat lead-ins. The view adds the `CountIn` overlay on the stage and the tolerance
choice in Settings → Reading help → Hints (`KeepTimeGroup`).
`views/practice/`: `PracticeView` reads `practiceRequest`, loads piece and package, builds the
session and `StripView` (`prepareLayout` + IndexedDB layout cache; re-prepared when
`maxLabelWidthChars` changes). The `PracticeEnv` seam is injectable for tests.
The mode (U141) is in the header (`ModeControl.tsx`): all four centered, or one button that opens
`ModeSheet` where they do not fit. `modeFit.ts` decides, measuring the header, the modes' natural
width (kept in the DOM unseen while the button shows) and a take's controls or pill; the same
measure drops the connection chip to its dot. A phone has the button in its bar (upright it is the
title). `PracticeMenuItems` shows the mode's rows, and `StartReason` (`Footer.tsx`) the reason the main
button is unavailable with Connect piano when only a piano is missing. The disconnect banner shows
only where the mode is played on the piano. `Banners` draws each status as the toasts' small capsule; each keeps its
last words while `useFadePresence` keeps it mounted to slide out (U166). `views/shared/modes.ts` has the modes' words.
The header and the overview stand on one ground, `.lid` (U154). Focus mode fades its `::before` away and the
overview row's capsule in; the overview takes its height and colors from `--overview-*`.
Focus mode collapses a phone's top bar (U93) and, on windows of 640 px or less, the wrapped footer-tools row, using CSS grid tracks (U60); a tablet's or desktop's header stays, its contents faded (U147), and a tablet's footer is one row in both orientations whose tools dim in place (U88).
Only the stage height changes (by 32 px on a tablet), so the existing score view remeasures without re-engraving.
`useRecede` restores chrome on pause, pointer/touch interaction, or keyboard navigation; it is
held off while `SessionUi.reviewing` (the review after a completed pass, U102). In Listen nothing
recedes (U72); only the cursor's repeat button goes while it plays.
On phone-size screens (`views/shared/usePhone`) Practice trades its header and footer for one top bar
and a menu sheet (U80). On every device the
portrait page is capped at the stage's width and fitted to it (`pageMaxWidth`, `fitWidth`, R17);
on a phone a pinch magnifies the page as engraved (`imageZoom`, 1× to 4×, never saved, U83) and the
app itself never zooms (`gesture*` events canceled in `app/boot.ts`, `touch-action` on the root).
`views/progress` (U148): `ProgressSheet` (in the Library's and Practice's bundles) is the sheet, at the end
side on tablets (`views/shared/LazySheet`, as `RecordingsSheet`), and imports `ProgressPanel` on its first opening: Work on next (`PieceSuggestionsModel` +
`SuggestionList`) and Past passes (`loadResultsData` → `passGroups`, a row unfolding to `HistoryPanel` and from
there `ScorecardPanel`). It knows no session: `onPractice(suggestion)` is
its caller's. Over the score that is `PracticeSession.practiceBars` (pause, mode, Repeat over the bars, their
hands and speed; nothing starts); from the Library `openPractice` with a preset. Practice holds input while
it is open (`holdInput`), as for Settings.
`views/results`: the panels and their data, for Progress and the practice result. `loadResultsData(storage,
{ pieceId, attemptId? })` (flush the history writer, read the piece, its attempts for one score version, the
package occurrences). `deriveResults` (pure) picks the attempt, builds `buildScorecard(attempt,
streakAsOfThen)` and its context's history; `passGroups` (pure) lists the scored attempts by context.
`ScorecardPanel` and `HistoryPanel` are presentational and leave help out (U144).
`views/shared/suggestions`: presentational `SuggestionList` / `SuggestionCard` (props:
`suggestions`, `improved`, `disabled`, `compact`, `headingLevel`, `title`, `onPractice`,
`onDismiss`, `onDisableSuggestions`, `onEnableSuggestions`, `disableLabel`, `renderPreview`),
`PieceSuggestionsModel` (`loadSuggestions` + `sessionDismissals`, the per-piece switch, refresh on
`history.subscribe`), text helpers, and the shared `sessionDismissals`.
Navigation requests: `openPractice({ pieceId, preset? })` sets `practiceRequest`. A request's `mode`
(only from an old `#/study/…` or `#/consult/…` link, which the router rewrites to `#/practice/…`)
opens the piece in it and saves nothing; it is forgotten once Practice is left.
`#/results/<piece>[/<attempt>]` (the Results page until U148) is rewritten to `#/practice/<piece>`.

**Only Back leaves Practice (U99).** Practice's exits are its Back button (to the Library) and the
overlays over it (Settings, sheets and popovers). The result's details open
in place: tap the whole pill or swipe up (U110). The collapsed pill has no actions and is the top of
the card, cut off (`ResultPeek`, U142): the first mistake's excerpt, drawn at rest by the details module
(fetched then), or the facts. The card's actions (Loop, Again) are under its verdict.
`AttemptResult` (`views/practice/Banners.tsx`) expands the pill into a card whose details
sit over the score and never change the dock's height (so `reviewInset`/`setReviewInset` never
see them): on a tablet a panel above the pill (up to 900 × 880 px, 16 px of margin on every
side); on a phone (`usePhone`) a fixed full-screen dialog with its own sticky header (U99); its contents load at the first rest after a result, or on the first expansion
(`ResultDetailsLoader` → `ResultDetails.tsx`). Swiping down on the pill or the phone's expanded
header calls `dismissResult`, which clears the result and marks and restores the playing zoom.
`PracticeSession.resultDetails()` hands over the last
result's inputs on demand; the card ranks them (`app/session/ranking.ts` `rankMistakes`, loaded with the card, fed by the last
passes of the context and `correctionMarksByGroup`), never in the input path.
**Result after a run (U142).** A Wait run outside Repeat that reaches the end of the piece shows the same
result: `app/session/run.ts` folds its reading traversals as they end (per onset group the latest time
it was played) into an in-memory `RunRecord`, which is a pass for the pill, the card, the marks and the
repeated-mistake check and is never stored; the traversals go to the history as ever. Outside Repeat
`app/session/rough.ts` finds the bars a Wait run or Keep time pass went worst in
(`AttemptSummary.rough`), which the card's Loop action opens Repeat over (`loopRoughBars`).
`render/excerpt.ts` (pure, string SVG) cuts one bar of the shown `PreparedLayout` (strip or page)
out of its segment markup with the signatures in front, the correction rings
(`shared/corrections.ts`) and ghost noteheads (`GhostNote`, placed by `pressGhost` relative to the
written note a wrong key stood for); it changes no render contract. The card reuses
`ScorecardPanel`, `HistoryPanel`, `deriveResults` and `loadResultsData`.
Mistake playback (U100, `app/session/snippets.ts`): `PassCapture` keeps a scored pass's or Wait run's
key and pedal events (sustain, sostenuto, soft; never the hint pedal; U101) in memory (one bounded
append per event in the input path, the oldest going in blocks past 16,384, the last completed pass
only, never stored);
`playedSnippet` builds a bar from the learner's presses and pedals, shortening pauses in waiting
practice. `writtenSnippet` uses the score and its pedal marks at the pass's speed. Every pedal
is released by the end. `SnippetPlayer` hands them to the practice output when due and
releases only its own notes and pedals. The session's `playSnippet`, `stopSnippet`,
`snippetBlocked` and `snippet` store drive it; on a route not verified echo-free the snippet's own
notes coming back are dropped from the input while they sound (its pedal controllers while it
plays), and any other key stops it before being handled as usual.

### Session 4 additions
- `ScoreModel.sections?` (I12) from `core/import/sections.ts`; `overviewMeasures(model, multiplier?)`
  (`ui/overviewMath.ts`) gives `ScoreOverview` `{start, duration, seconds?, section?}` per bar (U16), and
  `overviewNotes` (`ui/noteDrawing.ts`, U154) the notes it draws, one SVG path per hand; the played ones are a
  second copy behind a sliding window (two transforms).
- `render/strip/cursorPath.ts` maps positions to x along onset knots (R12); the cursor and its
  action button live in a screen-space layer (R13). Label font is loaded before metrics (R14).
- Practice: no PassageBar; `views/practice` footer holds Speed on the start side, the hand
  toggles + play in the middle, and a Menu button on the end side (an anchored popover,
  `FooterMenu.tsx`, with the mode's rows, U76 and U141); a Repeat panel (`RepeatPanel.tsx`:
  passage selector `LoopSteppers`, goal popover or phone sheet `RepeatOptions`, Exit repeat) floats over
  the Stage in Repeat mode, or has its own folding row under the overview on an upright phone (U12–U14, U89).
  `render/keyboard` draws all 88 keys (U15). `app/session/output.ts` resolves Auto (S4).
- Routing: `app/routes.ts` (parse/format) and `app/router.ts` (signal ⇄ URL sync, started in
  `boot.ts`) (A10). `?connection` is Settings on Piano and sound (`connectionOpen`, C8, U143).
  Portrait page mode (U40): `render/page/PageView` implements the same strip contract over a
  page layout (`PrepareOptions.mode: 'page'`, one segment per system); `views/practice/useOrientation`
  picks the view, and a rotation re-prepares and recreates it at the current position.
  Portrait label spacing (U65): `labels/spacing.ts` reserves adjacent-label envelopes at shared
  onset columns before collision placement. Up to three passes widen voice spacing to wrap
  bars, then widen the canvas when an isolated bar still cannot fit. Off stays compact.
  The requested width remains the cache key, with actual engraving width in layout params.
  Wider pages support horizontal browsing and cursor following, included in both-axis
  respacing, pointer geometry, loop edge scrolling, and visible-label assistance tracking.
  Page loop handles snap across systems using global passage bounds, wrap at horizontal edges,
  and scroll vertically near viewport edges (U59). Pointer capture and cancellation keep edits
  local until release, when `onLoopChange` commits the range.
  Practice flow (2026-10-31): every learner onset is a transport gate; nothing at or beyond an
  unreleased gate is emitted, so the automatic part sounds with the press, and an early release
  within the 120 ms grace fast-forwards the transport (P9, E12). In Repeat mode a seek before
  the loop sets up a lead-in on one transport that hands over to the scored attempt at the loop
  start (U38, `SessionUi.leadIn`). Records carry per-group outcomes (E15), which for a completed attempt or Wait run
  `app/session/corrections.ts` turns into `StripView.setCorrections` marks (U39); a wrong key
  pressed with a chord (within `CHORD_SLIP_MS`, also after a pass's final chord) is that chord's,
  and `app/session/mistakes.ts` finds the same wrong key at the same group three passes running
  (`AttemptSummary.repeatedMistakes`, P24; the result card words the first with
  `repeatedMistakeLine` on its note line, U97). At an automatic waiting-practice Repeat reset,
  the engine keeps the finished pass's wrong-key index by group (P26). It holds input
  completion briefly at those groups so a recurring extra key can invalidate the stroke
  before the cursor or accompaniment gate is released. The feedback store shows the retry cue.
  In every waiting mode a strike with a wrong key that ends incomplete is struck again whole (P33).
  While nothing plays, the session previews held keys against the current group (U37), using
  accepted noteheads and the keyboard guide. The strip's `wrapTo` method pans at a loop wrap.
  After a completed pass the session starts the review (U97) by calling the optional
  `StripSink.setReview(true)` from its frame. `StripView` blends its
  playing frame into a review frame (`render/strip/review.ts`: the whole loop beside the fixed
  signatures, never above the playing zoom nor below 0.6, above the result card's height from
  `setReviewInset`) frame by frame on transforms only, holds the music still and moves the cursor
  over it. `setReview(false)` blends back to the exact playing frame on the first correct note
  (U101) or during Keep time's last two count-in beats (U103). Keep time passes the downbeat as
  the animation deadline on the performance clock. Opening Details cancels the upcoming Keep
  time pass and restores its review frame while the score is resetting or counting in. The result
  card (`AttemptResult` in `views/practice/Banners.tsx`) docks at the bottom of the stage and
  `views/practice/reviewInset.ts` hands its height, measured against the strip's own root, to the
  strip. The card's intro and its opening and fold never change the dock's size: they are drawn
  with transforms, clips and opacity (`views/practice/resultMotion.ts`). The next pass's first correct
  note sets `SessionUi.resultDimmed` (the pill dims until the cursor
  leaves that bar; a one-bar loop ends the result at once); played past, `resultExit` is
  `'played'` and the pill slides away instead of fading.
  Theme tokens in `src/ui/global.css`: a four-step surface ramp (`--bg` / `--bg-elevated` /
  `--bg-sunken` / `--bg-raised`) that steps lighter with elevation in dark mode, and the accent
  as text (`--accent`) versus fill (`--accent-fill` + `--accent-fg`) (A12, A17, Olive U49).
  Hand controls have separate dark contrast tokens; `--practice-surface` keeps their surface
  themed when score paper is pinned light, with semantic light inks scoped to the score. Code style:
  Prettier without semicolons (D11).
- Performance (PF1–PF4): `ScoreOverview` `follow` (live position without renders),
  `useStoreValue` for coarse subscriptions, `StripView.flushFrame()` called at the end of the
  session frame, `pn-follow` for instant playback fills; `scripts/perf/` (`npm run perf`,
  `npm run perf:table`) measures the iPad stand-in.
- WP13: `PassageRange` optional `start` / `end` (`core/model/passage.ts` helpers; `passageKey`,
  `isWholeBars` in `practice.ts`). Strip: `setSnapPositions`, `setCursorDraggable`,
  `onCursorSeek`, `cursorDragLabel`, `strip/snap.ts`. Session: `snapOnsets`, boolean
  `seekPosition`.

### Practice motion and feedback revision (31 October 2026)

- The screen-space cursor never moves horizontally except when the viewport itself resizes.
  Pointer/keyboard seeks move the notation beneath it, and continuous interpolation passes
  through exact onset knots so a transport gate and its note align (U28, P9).
- The fixed clef/key/meter stage includes aligned staff lines, no divider, and a viewport-space
  opacity mask for passing notation (U29).
- `FlashDriver` only writes the damage overlay opacity. `OctaveFeedback` subscribes to
  `FeedbackState.octaveDirection` and renders an arrow in the stage margin (U30).

### Bug-hunt fixes (1 November 2026)
- Session: one `start()` at a time (`#starting`), the plan re-checked after sound loads;
  `#ensureTransport(then)` loads browser sound for a one-hand attempt or reading; the hands hold
  (U27) leaves an interrupted engine untouched; cues and the paused key check use
  `engine.timeline`; volume changes reach the loaded backend and metronome.
- Import: `noteVoice()` / `noteStaff()` in `read/part.ts` default a missing voice per staff;
  `keyEvents` and `partContext` synthesize the implicit opening key and clefs; endings are chosen
  before a forward repeat on the same bar. `IMPORTER_VERSION` 0.4.0.
- Storage: `commitImport` keeps a package shared with another piece (`replaceSharedPackage` for
  Review) and clears a version's layouts when its package changes; restore picks the package of
  the winning piece record per version; `getStorage()` wires `historyFailureNotices` (warning
  notices when the writer drops records).
- Playback: attacks ordered by `(min(s, nextGate), gateCount, s)`; deferred releases kept while
  the output is lost and never sent before a queued attack of the same pitch.
- Render: `render/shared/corrections.ts` holds the correction layout for both views (keyed by
  system); marks are owned by the note's segment; `requestedZoom` vs effective zoom;
  `ContextInput.xAt` places mid-bar clef changes; `ADAPTER_VERSION` pn-7.
- MIDI/app: `rememberRoute` resets the echo result when the input changes; `selectedInfo` falls
  back to a lost port only while it is lost; the hint-pedal learner takes a baseline snapshot at
  start; `startShell` sets `settingsLoading` before the theme sync.

### Installed app and offline (U84)
- `public/manifest.webmanifest` + `public/icons/` (rendered from the favicon by
  `scripts/render-icons.mjs`) + iOS head tags in `index.html` make the app installable.
- `scripts/pwa.ts` (Vite plugin, `writeBundle`): lists every file of `dist/` with its SHA-256
  (no `*.map`, no `.vite/`), stamps `index.html` with the build hash
  (`<meta name="pianissimo-build">`) and writes `dist/sw.js` = the type-stripped
  `src/workers/sw.ts` (a classic script) prefixed with `BUILD` and `ASSETS`.
- `src/workers/sw.ts`: precache per build (cache `pianissimo:<scope>:<build>`, unchanged files
  copied from older caches by hash, downloads checked with `integrity`), `skipWaiting` +
  `clients.claim`; navigations network first with a 3 s timeout, then the cached `index.html`;
  other in-scope GETs cache first (own build, then any build), else network (hashed `assets/`
  kept). Pages report their build (`pn-hello` over a `MessageChannel`); an older cache is
  deleted only when no open page runs it.
- `src/app/pwa.ts` (`startPwa()` from `main.tsx`, production only): registers `sw.js` with
  `updateViaCache: 'none'` after `load`, calls `registration.update()` at launch, on `online`
  and when shown again; on `controllerchange` asks the new worker whether this page's build is
  its own and, if not, reloads through `createReloader` only when not on Practice and
  no `dialog` is open, after flushing settings and the history writer.
