# Architecture

How the pieces fit. Module owners update their section when they change a public API.

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
| `src/core/model/settings.ts` | `AppSettings` and spec defaults (`SETTINGS_VERSION` 2: sound destination `'auto'`, S4). |
| `src/core/model/practice.ts` | Comparison contexts, `AttemptRecord`, `MeasureTraversal`, passages. |
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
- `buildTimeline(model, {hands, range, multiplier, tempo?})` → learner onset groups (distinct
  pitches, ties excluded, loop-start boundary reattacks), measures, automatic positions,
  expected attack span / notated duration, blockers, comparison context. Once per selection.
- `PracticeEngine`: `input(ev)` (consumed once by seq; positive Note On is the only attack),
  `tick(now)` / `nextDeadline()`, hints (`requestHint`, `dismissHint`), `setKeyboardVisible`,
  `recordPersistentLabelExposure`, lifecycle (`markPrepared`, `pause`, `resume`, `interrupt`,
  `restart`, `seek`, `reconfigure`, `updateSettings`), readonly `state` + `drainEvents()`.
- Transport seam: gates = `transportGates(timeline)`; `onGateReached(i)` →
  `transportArrived(i)`; event `input-complete {group}` → `transport.releaseGate(group)`.
  Free (both-hands) mode ignores arrivals.
- Labels: `temporaryLabelOpacity(now)` per frame (eased, active time); the renderer combines it
  with persistent labels by max. `fadeOutOpacity` is the shared smoothstep fade curve.
- Records: `attempt-ended {AttemptRecord}` (kind scored | reading), `measure`, `abandon`,
  `attempt-discarded` (ended before the first press). `exposure-reset` → re-report visible
  labels. The session calls `markPrepared` only after persistent-label fades finish.
- Scored: Preparing → Ready (prepared, keys and 64/66 released, hint fades done) → Running
  (first fresh press, even wrong) → Completed → restart. Reading: Running ⇄ Paused.
- `PlayFollower` (`follow.ts`, P12): the play-through follower over the same `Timeline`, beside
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
`'late'` slip, not a wrong attack. Strict records use `matchingRules` `strict-v1-tol-<n>ms` and
carry `rhythm`, `missedGroups` and per-group `offsetMs` / `missed`; they pass only with no wrong
attack, no assistance, no missed group and every group within the tolerance. Close times come
from injected arrivals and surface through `nextDeadline()`; `input-complete` is still emitted
but must not release gates in strict.

### core/audio (worker-safe)
The audio score follower behind play-through on an acoustic piano (DECISIONS P14 spike, P15
wiring). `features.ts` turns mono samples into one feature vector per 10 ms (log-spectral energy
per piano semitone plus a per-semitone onset rise; in-repo radix-2 FFT), `reference.ts` builds the
expected sequence from a `ScoreModel` and tempo map with harmonic templates (no synthesis),
`oltw.ts` aligns live frames to it by windowed online time warping, and `index.ts` exposes
`createAudioFollower(model, tempo, multiplier)` (`push(samples, sampleRate, time)` → position in
whole notes and a confidence; `reset(position)`). `groups.ts` (`groupReached(timeline, position)`)
is the only part the session bundles. `protocol.ts` + `workerHandler.ts` are the worker side
(`workers/follower.worker.ts` binds them): configure / reset / pause / resume / samples in,
estimates out every 20 ms of audio. `evaluate.ts` and `testkit.ts` are test support. Pure: no
DOM, no Web Audio.

### app/audio
`micFollower.ts` is the browser side of the microphone follower (P15): `getUserMedia` (no echo
cancellation, noise suppression or gain control) → an `AudioContext` with the AudioWorklet
`public/mic-processor.js` (512-sample blocks posted to the main thread) → the follower worker;
estimates reach the session's `#onMicEstimate`. `SessionDeps.createMicFollower` injects it
(tests use a fake); the session owns its lifetime (opened on Start in play-through with both
hands, closed when play-through ends or the hands change).

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
while the human holds that pitch, cleanup on the app channel only) and the lazily imported
browser-audio backend (one AudioContext, Salamander bank ≤ 32 MiB decoded, synth fallback).
The metronome is clicks scheduled by the same transport (free mode: click-only transport
started at the first press). Session wiring notes: `src/core/playback/README.md`.

### core/history and core/storage
history (pure, worker-safe): `ingestAttempt` / `ingestAbandon` fold engine records
(`AttemptRecord`, `MeasureTraversal`, `AbandonEvent`) into a per-piece `PieceHistory`
{bars, suggestions, abandons}; `selectSuggestions` builds up to three display-ready suggestions
plus Improved; `results` / `buildScorecard` summarize attempts per comparison context (best
clean unassisted vs assisted, streak). Bars are keyed (measureContextKey, occ); only complete
traversals enter the window of five.
storage (IndexedDB "pianissimo" v1, idb): `openStorage()` → `PianissimoStorage`. Stores:
pieces, sources, packages (both keyed by scoreVersionId), settings, attempts (indexes pieceId,
contextKey), measureHistory, suggestionState, abandonEvents, layoutCache (+meta, LRU by bytes
and count). `commitImport` writes source + package + piece in one transaction; `loadSettings`
merges stored settings over `DEFAULT_SETTINGS` field by field (`normalizeSettings`).
Practice records: the session calls `storage.history.queueAttempt` / `queueAbandon` (O(1),
never in the MIDI path); the `HistoryWriter` flushes on idle, `pagehide` and visibility-hidden
(`attachLifecycle()` once), ingests through core/history and writes attempts + changed
history in one transaction. Views call `loadSuggestions(pieceId, sessionDismissals)` and
`loadResults(pieceId)`. Export/restore (`*.pianissimo.zip`, format 1, fflate, lazily
imported): manifest + one JSON per store + sources/*.bin + packages/*.json, layout cache
excluded; restore validates everything first (`BackupError`, nothing written on failure) and
merges by id in one transaction. Details: `src/core/storage/README.md`.

Rhythm mode results (core/history, views/results, app/session/corrections): `timingAccuracy(record)`
summarizes a strict record's per-group `offsetMs` / `missed` against `rhythm.toleranceMs` (on
time, early, late, missed, mean and mean absolute offset). A clean unassisted completion needs
zero missed groups in every context, and strict clean runs rank by mean absolute offset.
`buildScorecard` gives completed strict records `timing: 'rhythm'` and timing rows (on-time
groups, early, late, missed, average offset, timing window) instead of completion, expected and
difference rows. The Results view names a strict context "Keep time · ±N ms". Teacher
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
emphasis + offscreen reminder, sticky clef/key/meter on staff lines with an opacity fade,
wrong-key cursor tint (`pulseWrong()`), theme via `--score-*` tokens (U8). A change of label
room swaps the engraving with a glide (`shared/respace.ts`: the wider engraving cut into onset
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
`practice`, `results`, `study`) to a component: `component` (static) or `load: () =>
import(...)` (lazy), and `chrome: 'bar' | 'none'` ('none' gives Practice and Study the whole
viewport). Navigation is `app/navigation.ts`;
Settings is an overlay over the mounted view, so the score and passage are never lost.
`app/state.ts` holds coarse signals only: `settings` (`updateSettings(patch)`, immutable deep
merge, per-clef rules merged per key), `connectionStatus`, `notices` (`pushNotice`). Storage
plugs in via `await setSettingsPersistence({load, save})` (debounced saves, flushed on
pagehide). Label changes go through `applyLabelSettings(next)`, which runs
`onBeforeApplyLabels` hooks first (the practice session registers one that interrupts a scored
attempt); naming-only changes use `updateSettings` and never interrupt.
`app/features.ts`: `getFeatures()` (MIDI, audio, module workers, IndexedDB, persist(), wake
lock, each with an explanation). `app/wakeLock.ts`: `wakeLock.hold(owner)` / `drop(owner)`.
`views/settings`: Settings tabs (label rules staged in a draft, applied explicitly).
`views/shared`: ConnectionChip, `suggestions/`, test helpers. `ui/`: tokens (motion, type,
spacing, elevation), controls, fades (`useFadePresence`), `WrongNoteFlash` (stationary damage
vignette, U2/U30), `HandToggles` (U4), `ScoreOverview` + `LoopSteppers` (U6), `TempoControl` (U7),
`BeatUnitIcon`. Props: `src/ui/README.md`.
`app/services.ts`: lazily created singletons. `getStorage()` opens IndexedDB once and attaches
the history lifecycle; `getMidiService()` / `getMidi()` own the one `MidiAdapter` and never
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
needed → `build` → summary review → `commitImport` → `requestPersistentStorage` once). Each async
step carries a job token; cancel/close bump it and dispose the client, so a canceled job never
updates the UI. `review.ts` applies `applyHandAssignment` / `withUserTempo` and re-checks
`summarizeImport(...).readiness`; only ready packages are stored (L1). Per-piece suggestions: `PieceSuggestionsModel`
(`loadSuggestions` + `sessionDismissals`, per-piece disable, Practice this passage →
`openPractice` preset, refresh on `history.subscribe`) rendered by the shared `SuggestionList`.
New imports navigate to Practice and start after layout preparation. Add unlocks the shared browser AudioContext during the click without loading samples.
Dependencies are injectable via `LibraryDeps` (tests: `views/library/testkit.ts`). Export and
restore are in Settings → Backup (`views/settings/BackupSection`, its own `LibraryModel`); the
Library refreshes its list when Settings close (L7).
`app/session/` (framework-free, all dependencies injected): `PracticeSession` owns one piece's
practice. Each human MIDI event → `MidiOutputBackend.humanInput` → `engine.input` → engine events
drained (`input-complete` → `transport.releaseGate`, records → `storage.history.queue*`). Visual
changes wait for one rAF frame (strip targets, accepted notes, wrong marker, ottava emphasis,
cursor, flash, label opacity = max(temporary, persistent), playback highlights, keyboard guide).
The view subscribes to four stores: `ui` (coarse), `progress`, `feedback`, `guide` (each at most
once per frame). All practice uses a gated musical transport (P9), silent for both hands and
playing the automatic part for one hand. It runs from Ready, holds at missing learner attacks,
and preserves the first-human-press attempt clock. Preview has no engine attempt. Feedback
includes an icon-only octave direction for same-pitch-class errors (U30); no generic error text.
Hiding the page saves progress without stopping playback (P10). Preparation calls `markPrepared`
once the strip is attached and persistent-label fades have finished. `practiceModel` applies a user
tempo; `createPieceSaver` debounces piece updates.
Starting playback resolves the optional `StripSink.browsedPosition()` to an exact seek and
calls `returnToCurrent()` to restore following, including after asynchronous sound loading.
The strip reports the nearest onset beneath its fixed cursor while browsing. The page reports
no alternate position because its cursor moves with the notation. Explicit accepted cursor
seeks also end browsing (U52). Existing Repeat seek and Listen range rules still apply.
Play-through (P12): `setPlayThrough(on)` closes Repeat mode and pauses reading; Start builds a
`#play` slot beside the engine, like Listen's: a gated transport over the whole piece (silent
for both hands, the automatic part for one) and a `PlayFollower`. Human events then go to the
follower instead of the engine (`#onMidi`), follower `release` events release transport gates,
`onGateReached` → `follower.transportArrived`, and the frame draws the follower's group, the
transport position, the amber tint for wrong presses and the guide. `ui.activity` is
`'playing'`, `ui.playThrough` true, `startAction` `'play'`; the engine records nothing while the
mode is on and resumes reading at the follower's group when it is switched off.
Speed ladder (U77): the piece's `ladder` (`LadderSettings { goal, step }`, null = off) is stored on
`PieceRecord` and opened into `PracticeSession`, which publishes `ui.ladder` (`{ goal, step,
start, failures, done }`); the pure rules are `app/session/ladder.ts`. After each completed
scored attempt while Repeat is open, meeting the consecutive-pass target (`repeatTarget ?? 3`)
climbs one step on the 5% grid toward the goal (or ends the climb at the goal); two failures in
a row drop one step, never below the start speed; manual speed changes reset the failures and
can lower the floor. The new speed takes effect at the Repeat reset through the ordinary
speed-change path, and `AttemptSummary.ladder` tells the result card what happened.
Keep time (rhythm mode, P13, U78): `PracticeSession.setRhythmMode` (saved per piece as
`PieceRecord.rhythm`) turns every Start into a scored attempt on the engine's strict transport,
with `rhythm.toleranceMs` from `AppSettings.rhythm`, over the Repeat loop or else the whole
piece. When the engine is Ready the session counts in one bar (`countIn.ts`) through the
metronome sink and publishes `ui.countIn`; at the end it calls `engine.startRunning(t)` and
`transport.play(t)` with one timestamp after releasing every gate, so the music never holds. The
transport reports each arrival (`transportArrived`); the engine judges, closes missed groups and
builds the record. The session renders only gentle feedback (soft wash for `missed`, amber
marker for `'late'`) and the result card's timing row (`timingAccuracy`). Keep time is exclusive
with play-through and disables Repeat lead-ins. The view adds a footer-menu switch with a badge
on the Menu button, the `CountIn` overlay on the stage and the tolerance choice in Settings →
Hints (`KeepTimeGroup`).
`views/practice/`: `PracticeView` reads `practiceRequest`, loads piece and package, builds the
session and `StripView` (`prepareLayout` + IndexedDB layout cache; re-prepared when
`maxLabelWidthChars` changes). The `PracticeEnv` seam is injectable for tests.
The footer's **Play through** tool (icon `flow`, `aria-pressed`, disabled while the hands are
off) toggles play-through; the main button reads Start / Pause / Resume there, and no result card,
interruption or Repeat panel shows while `activity === 'playing'`.
Focus mode collapses the header and narrow footer-tools row using CSS grid tracks (U60).
Only the stage height changes, so the existing score view remeasures without re-engraving.
`useRecede` restores chrome on pause, pointer/touch interaction, or keyboard navigation.
`views/study` (U72): `StudyView` reads `studyRequest` (`openStudy({pieceId})`, route
`#/study/<pieceId>`) and runs a `PracticeSession` in Listen (`hands: 'none'`,
`cursorAction: false`, no-op history and piece sinks) over the same score views, layouts and
`PracticeEnv` as Practice: playback, Note names, `session.revealAtCursor()` (names of both
hands' notes at the cursor for the hint lifetime, a third label-opacity source merged with the
persistent and temporary ones) and the keyboard guide, on any device including a phone; nothing
of practice is offered or recorded. On phone-size screens (`views/shared/usePhone`) both Practice
and Study trade their header and footer for one top bar and a menu sheet (U74, U80), and the
portrait page is capped at the stage's width and fitted to it (`pageMaxWidth`, `fitWidth`, R17).
`views/results`: `ResultsView` reads `resultsRequest` and calls `loadResultsData(storage,
request, sessionDismissals)` (flush the history writer, read the piece, its attempts for one
score version, the package occurrences, `loadSuggestions`). `deriveResults` (pure) picks the
attempt, builds `buildScorecard(attempt, streakAsOfThen)` and splits `summarizeByContext` into the
attempt's context history and "other settings". `ScorecardPanel` and `HistoryPanel` are
presentational. "Practice again" / "Practice this passage" call `openPractice` with
`{passage, hands, multiplier}` and never start practice.
`views/shared/suggestions`: presentational `SuggestionList` / `SuggestionCard` (props:
`suggestions`, `improved`, `disabled`, `compact`, `headingLevel`, `title`, `showHeading`, `onPractice`,
`onDismiss`, `onDisableSuggestions`, `onEnableSuggestions`, `disableLabel`, `renderPreview`), text
helpers, and `sessionDismissals`, the shared `SessionDismissals` instance used by Library and
Results.
Navigation requests: `openPractice({ pieceId, preset?, autoStart? })` sets `practiceRequest`;
`autoStart` is a one-shot import handoff consumed after notation preparation (L6).
`openResults({ pieceId, attemptId? })` sets `resultsRequest` (both in `app/navigation.ts`).

### Session 4 additions
- `ScoreModel.sections?` (I12) from `core/import/sections.ts`; `overviewMeasures(model, multiplier?)`
  (`ui/overviewMath.ts`) gives `ScoreOverview` `{start, duration, seconds?, section?}` per bar (U16).
- `render/strip/cursorPath.ts` maps positions to x along onset knots (R12); the cursor and its
  action button live in a screen-space layer (R13). Label font is loaded before metrics (R14).
- Practice: no PassageBar; `views/practice` footer holds Speed on the start side, the hand
  toggles + play in the middle, and a Menu button on the end side (an anchored popover,
  `FooterMenu.tsx`, with Note names, Play through and Show keys, U76); a Repeat panel floats over the Stage in
  Repeat mode (U12–U14).
  `render/keyboard` draws all 88 keys (U15). `app/session/output.ts` resolves Auto (S4).
- Routing: `app/routes.ts` (parse/format) and `app/router.ts` (signal ⇄ URL sync, started in
  `boot.ts`) (A10). Connection setup is `views/connection/ConnectionModal.tsx` over any view (C8).
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
  start (U38, `SessionUi.leadIn`). Completed scored records carry per-group outcomes (E15) that
  `app/session/corrections.ts` turns into `StripView.setCorrections` marks (U39). While nothing
  plays the session previews held keys against the current group (U37). Strip extras:
  `wrapTo` (loop wrap pan), `setEarlyMarker` (amber tint), the cursor bar bounded to the staves.
  Theme tokens in `src/ui/global.css`: a four-step surface ramp (`--bg` / `--bg-elevated` /
  `--bg-sunken` / `--bg-raised`) that steps lighter with elevation in dark mode, and the accent
  as text (`--accent`) versus fill (`--accent-fill` + `--accent-fg`) (A12, A17, Olive U49).
  Hand controls have separate dark contrast tokens; `--practice-surface` keeps their surface
  themed when score paper is pinned light, with semantic light inks scoped to the score. Without a
  connected piano the session holds the hands in Listen (`setInputAvailable`, U27). Code style:
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
