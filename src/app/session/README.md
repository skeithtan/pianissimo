# app/session — practice session coordinator (WP10)

Framework-free wiring of one practice session: MIDI input → `PracticeEngine` → transport →
`StripView` / keyboard guide / flash → storage. Every dependency is injected (`SessionDeps`),
so the whole coordinator runs in Vitest with a manual clock, manual frames, scripted MIDI, a
recording strip and a recording MIDI backend (`testkit.ts`).

Spec: "Practice screen", "Score following", "Mistake feedback and hints", "Persistent score
labels", "Keyboard rescue", "Repeating passages", "Results and timing", "Listening and hand
practice", "Execution and rendering architecture", "Storage and recovery" (resume).

## Public API (`index.ts`)

| Export | Purpose |
| --- | --- |
| `new PracticeSession({pieceId, model, selection, settings, startPosition?, repeatTarget?}, deps)` | One session per opened piece. |
| `practiceModel(model, userTempo)` | Applies a user-supplied tempo (`withUserTempo`) when the score has none. |
| `selectionTimeline`, `startPlan`, `passageSummary`, `rangeText`, `tempoText`, `clampPassage`, `HAND_TEXT` | Selection helpers (timeline, plain-language blockers, "Right hand · Bars 5–8 · 80% (♩ = 58)"). |
| `PersistentLabels`, `labelSnapshot`, `mergeOpacity` | Persistent label texts, eligibility and fades; engine label snapshot (`rulesJson = JSON.stringify(labels.rules)`). |
| `accompanimentAllowed`, `hasSoundOutput` | Output rules (`output.ts`: `playbackDestination` resolves Auto / Connected piano / Browser sound; graded accompaniment needs browser sound or a verified echo-free MIDI output). |
| `createPieceSaver(write, timers)` | Debounced `updatePiece` writes; `immediate` for pause/seek/hide. |
| `Store` / `ReadonlyStore` | Tiny observable used for the view stores. |

### `PracticeSession`

Controls: `togglePlay()`, `start()` (reading, a scored attempt, or Listen with hands 'none' —
always both parts), `pause()`, `restart()`, `resume()`, `seek(occ)`, `seekPosition(pos)`,
`requestHint()`, `setKeyboardVisible(v)`, `setRepeatMode(open, at?)`, `repeatFrom(occ)` (a fresh
one-bar loop), `repeatAtCursor()` (the cursor's repeat button: pauses what plays, then opens
Repeat at the cursor's bar), `setChromeRevealed(bool)` (the view's chrome is revealed, not in
focus mode; default true), `setInputAvailable(bool)` (no piano input: the hands
are held in Listen without saving `lastHands`, U27), `setRepeatTarget(n)`, `dismissResult()`,
`setSelection({hands?, range?, multiplier?})`, `updateSettings(settings)`,
`beforeApplyLabels(next)` (register with `onBeforeApplyLabels`), `layoutChanging()`
(re-prepare), `viewChanged()` (zoom / orientation; never interrupts, P5 revised), `suspend()` (save progress when hidden without pausing), `dispose()`.
Strip: `attachStrip(strip)`, `detachStrip()`, `attachFlash(handle)`, `onVisibleLabels(added)`.

Note-level loops and the draggable playhead (WP13, DECISIONS U19, U21–U23): `selection.range` /
`setSelection({range})` accept `PassageRange` with exact `start` / `end` (normalized by
`clampPassage` = `normalizePassage`: edges on a barline are dropped). `seekPosition(pos)` returns
whether the position was taken (false in a scored attempt, P6) — the strip's dragged playhead
(`StripOptions.onCursorSeek`) lands on a note and reading continues there; Listen seeks its
transport. `snapOnsets` is the hands' onset list (cached per hand selection) handed to
`strip.setSnapPositions`; `strip.setCursorDraggable` is on
while paused or idle outside Repeat mode (never in Repeat mode, where every pass starts at the
loop start). The cursor's repeat button (`strip.setCursorAction(visible)`) shows outside Repeat
mode only: `!repeat && (!playing || chromeRevealed)`, so while playing it goes with focus mode
(U14). When a Repeat pass starts over, `strip.wrapTo?(loopStart)` lets the strip pan back fast.

Lead-in (Repeat mode): `seek(occ)` to any bar but the loop's first bar, or `seekPosition(pos)`
anywhere but the loop start, keeps Repeat mode and the loop (`lastPassage` unchanged) and sets up
a lead-in there: the cursor and the stage move to it at once (`ui.leadIn` true; `startAction`
stays 'scored'; activity 'idle' until Start, then 'reading'; a running attempt is interrupted
first, 'seek', P6). Start reads it like ordinary reading (same hands, tempo and gates, Pause keeps
progress, Resume continues); the scored attempt takes over the next time the music arrives at the
loop start. **Before the loop** the lead-in passage is `[pos, loop start)` on **one** transport
over `[pos, loop end)` whose gates are the lead-in timeline's groups followed by the loop's
(engine group i = gate i + `#gateOffset`). When the reading engine completes the lead-in's last
group (`#handOver`), the engine is reconfigured to the scored loop timeline with
`runningStart: true` (the transport is already running into the first gate, so its lateness
counts), physical key/pedal state is forgotten and `markPrepared` runs at once, so the attempt is
Ready while the music plays on toward the loop's first gate; the clock starts with the first press
as usual. **Inside the loop** the lead-in passage is `[pos, loop end)`, **after the loop**
`[pos, piece end)` (`LeadIn.wrap`), each on its own transport over the passage with only its own
gates. Its last group completed, the music plays on to the passage end (`playing` stays true,
`finished` false, the loop handles stay locked); there `#onAccompanimentEnd` calls `#wrapLeadIn`:
the loop's own transport replaces the lead-in one, the engine is reconfigured to the scored loop
timeline (no `runningStart`: the loop transport waits at its first gate for the first press, as
any Repeat pass), physical state is forgotten, `markPrepared` runs at once and
`strip.wrapTo?(loopStart)` pans back (U35). The next attempt (`#prepareAttempt`: Repeat reset,
Restart, Start) replaces a lead-in transport with the loop's own one, so Repeat wraps to the loop
start. Restart during the lead-in prepares an attempt at the loop start; a seek to the loop start
drops the lead-in (the attempt waits at the loop start as before); a speed change keeps it; any
other selection change ends it (stopped, like Repeat mode). Lead-in reading traversals are not
recorded.

Teacher corrections (`corrections.ts`): when a scored attempt completes, `correctionMarks(record,
timeline, model, settings.naming)` turns the record's per-group outcomes into one mark per group
with a problem, the first of: a wrong pitch one semitone from a required pitch on its letter
(`'accidental'`, "F♯, not F": the target spelled as the score does, accidental always shown, the
naming settings honored), a wrong pitch 12 or 24 semitones from one (`'octave'`, "Wrong octave ↑"
/ "↓" toward the right one), another wrong key (`'wrong'`, "Wrong note" / "Wrong notes"), a
re-attacked tie end (`'tie'`, "Tied, hold it"), a chord of two or more pitches spread over
`SPREAD_MARK_MS` (90 ms) or more (`'spread'`, "Together"), a right pitch too early ("Too soon"),
completed at least `LATE_MARK_MS` (350 ms) after the music reached the gate ("Too late"). Outcomes
without the newer optional fields (older records) give only the older classes. A mark's notes are
the group's note indices whose onset lies inside the attempt's passage (`passageBounds`; a tie
head before the loop start is never ringed; a mark with none left is dropped), handed to
`strip.setCorrections?(marks)`; `ui.corrections` is their count. Live, a `wrong` event with reason
`'tie-end'` only tints the cursor amber (like too early): no pulse, flash, red marker or cue.
Interrupted or abandoned attempts draw none. They stay while the result card shows and clear
(`#clearCorrections`) on Start, Restart, `dismissResult()`, a selection change, a seek and
`dispose()`. A Repeat pass that starts over by itself keeps them through Ready until the first
press of the new pass (any key: the attempt starts running). A re-attached strip gets them again.

Stores (subscribe from the view):

| Store | Changes | Consumers |
| --- | --- | --- |
| `ui: SessionUi` | phase/selection/coarse status only (published from the frame, shallow-compared) | the screen |
| `progress: {position, occ}` | ≤ once per frame | `ScoreOverview`, `LoopSteppers` |
| `feedback: {visible, reason, pulse, cue}` | ≤ once per frame | `StageCue` at the cursor: `{kind: 'octave', direction}` or `{kind: 'accidental', text, accidental}` (U30 revised) |
| `guide: {keys, rollDirection}` | ≤ once per frame while the guide is visible, only when a key changed (`guide.ts`) | `KeyboardGuide` |

## How it works

- **Input path (O(small)).** `midi.subscribe` → `midiBackend.humanInput(ev)` (human-held
  release guard) → optional browser monitoring → `engine.input(ev)` → drain engine events.
  Draining releases transport gates (`input-complete` → `releaseGate`) synchronously, queues
  records (`history.queueAttempt/queueAbandon`, O(1)) and schedules **one** animation frame.
  Nothing in the input path renders, writes storage or touches the DOM. Tested: a burst of
  five presses produces 0 `ui` emissions before the frame and ≤ 1 `progress` emission.
- **Frame.** On engine `state.version` change: `setTargets / setAccepted / setWrongMarker /
  setEarlyMarker? / setOttavaEmphasis`, the correction cue. Loop editing, browsing and the strip's
  cursor repeat button (`setCursorAction(visible)`, outside Repeat mode while paused or while the
  chrome is revealed) follow the state. The keyboard guide (`buildGuideKeys`: targets, held and wrong keys, and what playback
  sounds, named with the naming settings) is rebuilt on a version or playback-highlight change
  while it is visible. Wrong attacks since the
  last frame → `strip.pulseWrong()` and `flash.hit(now, wrongFeedbackUntil)`; a right pitch too
  early → `flash.hit(now, until, { soft: true })` and the amber `setEarlyMarker?(true)` instead
  (P3 revised; the marker follows `groupHasError`, so completion, advance, seek, restart, mode
  changes and interruptions clear it).
  Labels: `engine.temporaryLabelOpacity(now)` merged with persistent opacity by max →
  `setLabelOpacity` only when either changed. Practice and Preview cursor = `transport.positionNow()`;
  playback highlights from `onEmit` events applied at their scheduled times. Frames keep
  running only while something animates (hint fades, persistent fades, moving transport, highlights).
  A practice gate stops the flow until all required pitches have been played; accepted early
  presses never move the score ahead of musical time. Wrong-octave attacks choose the nearest
  missing pitch of the same pitch class (equal distances favor the lower pitch) → an octave cue.
  A key one semitone from a missing pitch on the same letter (F for F♯; F♯ / G♭ for F♮ or G♮)
  → an accidental cue naming the target as the score spells it, with the naming settings and its
  accidental always shown (♮ for a natural). Unrelated errors and early timing errors clear the
  cue, as do accepting its target pitch and lifecycle changes.
- **Ticks.** One timer at `min(engine.nextDeadline(), hint fade start, persistent fade end)`
  → `engine.tick(now)`.
- **Modes** (DECISIONS P1): no passage → ordinary reading (Start resumes from the current
  position, Pause keeps progress); passage → scored attempt (Preparing → Ready → Running →
  Completed; Pause interrupts); hands 'none' → Preview. Every practice mode uses a gated
  transport (`transportGates`, `onGateReached` → `transportArrived(i, clock())`, `transportEta`
  → `msUntilGate`). Both hands uses no sound backend or automatic events; one-hand adds the
  accompaniment. The metronome uses the same gated clock. Ready starts the transport, while
  the attempt clock still waits for the first fresh press. A numerical tempo is required.
- **Preparation / Repeat.** Start or a repeat reset: transports back to the passage start,
  `awaitPrepared`; `markPrepared` once the strip is attached, the accompaniment exists and
  persistent-label fades have finished; the engine waits for released keys / 64 / 66 and hint
  fades (waiting text "Release the keys to begin."). Repeat after completion: accompaniment finishes to the boundary (`onRangeEnd`), then
  `stop` (cleanup) → `engine.restart` → prepare; the decision is taken after the whole event
  batch so the attempt record is known (consecutive-pass target).
- **Interruptions.** Pause (scored; no banner, the main button reads Start), seek while running,
  hands/range/speed change (new attempt prepared when still allowed), label mode/rule
  (`beforeApplyLabels`), layout (`layoutChanging`; zoom and orientation never interrupt), opening
  an overlay (`holdInput` pauses), input/output
  disconnect (`onRoute`; reconnect → `resetPhysical` + `resetHuman`), Stop sound (registered
  owner), leaving the view (`user-stop`). Reading interruptions offer Resume / Restart. Hiding
  the page only saves progress: it does not pause practice, Listen, or their transports.
- **Persistence.** `lastHands/lastPassage/lastMultiplier` on selection change (debounced),
  `repeatTarget`, `resume` on pause/seek/hide/dispose and every ≥ 5 s of reading (from the
  frame, never per event); cleared at the end of the piece.
- **Sound** (DECISIONS S4). `playbackDestination(settings, output, browserSound)`: Auto (the
  default) → the MIDI output when there is one, else browser sound; Connected piano → MIDI only;
  Browser sound → this device only. The MIDI backend is built synchronously from
  `midi.output()` and the route channel (`humanGuard` off on an echoing route); browser sound is
  loaded by `deps.loadBrowserAudio` only after a Start / Play gesture, so use with a piano never
  imports the bank (Playwright-checked). Under Auto a piano connecting while the device plays
  stops playback cleanly (the next Start uses the piano); a piano disconnecting interrupts and
  the next Start continues through the device. The metronome is separate (Web Audio).

## Tests

`PracticeSession.test.ts` (reading, scored lifecycle, repeat readiness, Repeat mode and the
cursor repeat button, loop wrap, interruptions, disconnect, continuous timing for both hands,
gate waiting, early grace and the soft early feedback, octave and accidental cues, background
playback, Listen,
Auto sound destination, hints, persistent-label exposure and fades, keyboard guide and
assistance, naming, no per-event UI publication), `guide.test.ts`, `labels.test.ts`,
`selection.test.ts`, `persistence.test.ts`. `npx vitest run src/app/session`.

## Decisions

See DECISIONS P2–P8 (proposed in the WP10 report): accompaniment allowed with browser sound;
zoom/orientation never interrupt (P5 revised); seeks
ignored while a scored attempt is preparing/ready; Preview interrupts a scored attempt;
leaving the view is a user stop.
