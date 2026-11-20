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
| `new PracticeSession({pieceId, model, selection, settings, startPosition?, repeatTarget?, ladder?, rhythm?}, deps)` | One session per opened piece (`rhythm`: the piece's saved Keep time choice). |
| `LADDER_DEFAULT_TARGET`, `LADDER_DROP_AFTER`, `LADDER_STEP` | Speed ladder constants (3 passes per rung without a Repeat target, 2 failures per drop, the 5% step the screen sets). |
| `practiceModel(model, userTempo)` | Applies a user-supplied tempo (`withUserTempo`) when the score has none. |
| `selectionTimeline`, `startPlan`, `passageSummary`, `rangeText`, `tempoText`, `clampPassage`, `HAND_TEXT` | Selection helpers (timeline, plain-language blockers, "Right hand · Bars 5–8 · 80% (♩ = 58)"). |
| `PersistentLabels`, `labelSnapshot`, `mergeOpacity` | Persistent label texts, eligibility and fades; engine label snapshot (`rulesJson = JSON.stringify(labels.rules)`). |
| `accompanimentAllowed`, `hasSoundOutput` | Output rules (`output.ts`: `playbackDestination` resolves Auto / Connected piano / Browser sound; graded accompaniment needs browser sound or a verified echo-free MIDI output). |
| `createPieceSaver(write, timers)` | `updatePiece` writes, coalesced (one in flight); debounced unless `immediate` (learner changes, pause/seek/hide). |
| `Store` / `ReadonlyStore` | Tiny observable used for the view stores. |
| `repeatedMistakes`, `repeatedMistakeLine`, `REPEATED_MISTAKE_PASSES`, `RepeatedMistake` | Repeated mistakes (`mistakes.ts`, P24, below). |

### `PracticeSession`

Study mode (U72): `SessionOptions.cursorAction: false` keeps the cursor's repeat button off
for good, and `revealAtCursor()` names both hands' notes at the cursor for the hint lifetime
(`REVEAL_FALLBACK_S` when hints last until the correct note), fading over `hints.fadeMs`; it is
a third label-opacity source merged with the persistent and temporary ones, independent of any
attempt.

Controls: `togglePlay()`, `start()` (reading, a scored attempt, or Listen with hands 'none' —
always both parts), `pause()`, `restart()`, `resume()`, `seek(occ)`, `seekPosition(pos)`,
`requestHint()`, `setKeyboardVisible(v)`, `setRepeatMode(open, at?)` (saved on the piece as `repeatOpen`, U98; `SessionOptions.repeat` opens
with it on over `selection.range`, clamped), `repeatFrom(occ)` (a fresh
one-bar loop), `repeatAtCursor(occ?)` (the cursor's repeat button: pauses what plays, then opens
Repeat at the bar the button was over: `occ` when the view reports one, the strip's bar under its
fixed cursor line while browsing, else the cursor's bar), `setChromeRevealed(bool)` (the view's chrome is revealed, not in
focus mode; default true), `setInputAvailable(bool)` (no piano input: play-through follows the
microphone and is on while a hand is selected, P22; only when the microphone is impossible too are
the hands held in Listen without saving `lastHands`, U27), `setRepeatTarget(n)`, `setLadder(ladder | null)` (speed ladder, below), `setRhythmMode(on)` (Keep time, below), `dismissResult()`,
`setSelection({hands?, range?, multiplier?})`, `updateSettings(settings)`,
`beforeApplyLabels(next)` (register with `onBeforeApplyLabels`), `layoutChanging()`
(re-prepare), `viewChanged()` (zoom / orientation; never interrupts, P5 revised), `suspend()` (save progress when hidden without pausing), `dispose()`.
Strip: `attachStrip(strip)`, `detachStrip()`, `attachFlash(handle)`, `onVisibleLabels(added)`,
`browseStarted()`, `browseReleased()` (U41, U95).

Loop changes while Repeat plays (U94, `#select`): a `range-change` while the main button shows
Pause (or a browse hold waits) keeps playing. `#continueFrom()` reads where playback is, exact,
before anything changes (the next note of a running attempt or lead-in; the onset at or after the
cursor for Listen or music playing on; null at Ready). Listen rebuilds its transport over the new
loop from there when it lies inside it, else from the loop start (`#replayListen`). With a hand
on, the attempt in progress ends as 'range-change', then `#seekLeadIn(from, now, {play: true,
reason})` plays a lead-in from a position inside the new loop (or before it, when a lead-in was
reading toward the loop), and otherwise the next attempt waits at the loop start at Ready (Keep
time always; an attempt still at Ready too). Paused, a loop change only moves the loop.

Browsing (U41, U95): `browseStarted()` (the view's `onBrowse(true)`) while something plays (Pause
showing, Ready and a finished pass's music included) pauses it and discards the attempt or reading
pass in progress, and records a hold (`#browseHold`, with `#continueFrom()`); `ui.playing` stays
true during the hold. `browseReleased()` (`StripOptions.onBrowseRelease`: last finger up or
canceled, 250 ms wheel idle, or a handle drag that scrolled) then calls `start()`, which adopts the
browsed note as below. Any Pause (`pause()`, an overlay, a lost input or output, `detachStrip`,
`dispose`) or a Start ends the hold; a loop change during it resolves it by U94 and calls
`returnToCurrent()`. The page layout (`browsedPosition()` null while browsing) pauses nothing.

Start adopts the notation's optional `browsedPosition()` before resuming playback, then calls
`returnToCurrent()` to restore cursor following. The fixed strip returns the onset underneath
its visible cursor, while the page layout returns null because its cursor already marks the
session position. This is checked again after sound loading so a later browse or seek wins.
Reading and scored lead-ins use the existing seek rules. Listen honors the selected onset
inside its loop and keeps playback within that loop. A seek made while changing sound outputs
also replaces the paused Listen position captured before the new output finished loading.
A Start waits for sounds (`#ensureOutput`, `#ensureMetronome`, `#startMic`); afterwards it
re-reads the plan (a hand chosen meanwhile turns a Listen Start into reading, and the reverse)
and starts nothing when a Pause came in meanwhile (`#startGen`, bumped by `pause()`: an overlay,
browsing, Stop sound), leaving the session as that Pause did. A Start pressed again after such a
Pause runs once the canceled one has returned, unless another Pause came in by then; otherwise a
second Start joins the first.

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
first, 'seek', P6). A seek while Repeat plays (an attempt, a finished pass's music playing on, a
lead-in) keeps playing from there: the lead-in starts at once, and a seek to the loop start
begins the next attempt there at Ready (U70); while paused or before Start it waits. Start reads it like ordinary reading (same hands, tempo and gates, Pause keeps
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
drops the lead-in (the attempt waits at the loop start as before); a speed change keeps it; a
loop change goes on by U94 (below); any other selection change ends it (stopped, like Repeat mode). Lead-in reading traversals are not
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
`dispose()`. A Repeat pass that starts over by itself keeps them through Ready and through wrong
keys until the new pass's first correct note (U101: the engine's first `accepted` event while the
result shows, `#resultPlayed`). A re-attached strip gets them again.

The result while the next pass begins (U101): wrong keys leave the result and marks in place.
The first correct note clears the marks. On a one-bar loop it ends the result (`#endResultByPlay`),
otherwise `#resultPlayedIn` keeps that note's bar and `ui.resultDimmed` is true until an
`advanced` event takes the cursor out of it, which ends the result. Ended that way,
`ui.resultExit` is `'played'` (the view slides the pill away); any other end leaves it
`'dismissed'`. Both checks are O(1) in the input path.

The review (U97) begins when a completed loop's result appears. `#syncReview` calls the optional
`strip.setReview?(on, returnBy)` from the session frame and on `attachStrip`. The review ends on
the first correct note in waiting practice (U101), on count 2 in Keep time (U103), or when the
result is dismissed. Keep time sets `#reviewReturnBy` at the last two count-in beats and passes
the downbeat as the deadline for the strip's zoom. The deadline also keeps review off for that
result until the next pass completes. `openResultDetails` pauses the session if another Keep time
pass is pending, preparing, or counting in, restoring the review frame for that result. Starting
again counts in from the beginning. A reattached strip receives the current review state.
The card's note line is the first of `lastResult.repeatedMistakes`, worded by the view (below).

Repeated mistakes (`mistakes.ts`, DECISIONS P24): `#onRecord` keeps the last
`REPEATED_MISTAKE_HISTORY` (8) scored records of the current comparison context (cleared when it
changes) and, for a completed one, marks it pending with the timeline it ran on; the next UI
publish (the frame, never the input path) works out `repeatedMistakes(records, timeline, model)`
and sets `lastResult.repeatedMistakes` (absent when none): the same wrong pitch at the same group
in `REPEATED_MISTAKE_PASSES` (3) passes running, the latest included (a pass stopped before the
group is skipped, one that reached it without that key ends the run), most passes first. Each
`RepeatedMistake` = `{ group, occ, bar, expectedPitches, expectedPitch, expectedNote, wrongPitch,
passes }`; `expectedPitch` / `expectedNote` is the required note the key most likely stood for
(same letter a semitone away, else an octave away, else the nearest). `repeatedMistakeLine(m,
model, naming)` words it for the result card's note line (the view calls it on render, U97): "F instead of F♯ in bar 12, three passes running"
(score spelling with its accidental, ♮ against the same letter, octave numbers only for a wrong
octave, counts in words up to ten). Chord slips (P24) reach the session as `wrong` events of the
group just completed: they flash and pulse like any wrong key, but no cue is computed (the cue
points toward the current group). `SessionDeps.finalSlipMs` (default `CHORD_SLIP_MS`) is the
engine's final-chord hold; the test harness passes 0 so scenario tests see the record at the
final key. Tests: `mistakes.test.ts`, `PracticeSession.mistakes.test.ts`;
`PracticeSession.required.test.ts` sweeps one-hand presses through the session (P23).

The next automatic waiting-practice Repeat pass calls `engine.restart(now, { continueRepeat: true })`
(P26). A recurring extra key keeps the transport at that onset and clears accepted notes there.
The feedback store shows "Try again" until the player replays the written pitches.

Stores (subscribe from the view):

| Store | Changes | Consumers |
| --- | --- | --- |
| `ui: SessionUi` | phase/selection/coarse status only (published from the frame, shallow-compared; `countIn` once per count-in beat) | the screen |
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
  owner), leaving the view (`user-stop`; a paused reading pass, also under an overlay, ends with
  `'suspend'`, so it is recorded without an abandon event). Reading interruptions offer Resume / Restart. Hiding
  the page only saves progress: it does not pause practice, Listen, or their transports.
- **Persistence.** `lastHands/lastPassage/lastMultiplier` on selection change, `repeatOpen` (Repeat
  mode on, DECISIONS U98) whenever Repeat opens or closes and `false` with `lastPassage: null`
  when the loop is cleared. Hands, speed, loop, Repeat mode, `repeatTarget`, `ladder` and
  `rhythm` (Keep time) are written at once (taps and drags, never the MIDI path; a reload right
  after must find them) and coalesced by the saver; only the ladder's own speed step (from the
  MIDI path) and the periodic resume position are debounced. `resume` on pause/seek/hide/dispose and every ≥ 5 s of
  reading (from the frame, never per event); cleared at the end of the piece. The last result,
  corrections, streak, ladder failures and play-through are never saved: a session opened with
  `repeat: true` from the stored loop (`PracticeScreen`) starts paused at the loop start with no
  result, the ladder restarting from the stored speed.
- **Sound** (DECISIONS S4). `playbackDestination(settings, output, browserSound)`: Auto (the
  default) → the MIDI output when there is one, else browser sound; Connected piano → MIDI only;
  Browser sound → this device only. The MIDI backend is built synchronously from
  `midi.output()` and the route channel (`humanGuardEnabled`: `humanGuard` on only on a route
  verified echo-free, off while the echo is untested); browser sound is loaded by
  `deps.loadBrowserAudio` only after a Start / Play gesture, so use with a piano never
  imports the bank (Playwright-checked). Under Auto a piano connecting while the device plays
  stops playback cleanly (the next Start uses the piano); a piano disconnecting interrupts and
  the next Start continues through the device. The metronome is separate (Web Audio).

## Speed ladder (Repeat mode)

The metronome-ladder technique, automated (`ladder.ts` holds the pure rules, the session applies
them). `SessionOptions.ladder` / `setLadder(LadderSettings | null)` set it (`{ goal, step }`,
speed multipliers; saved on the piece as `ladder` through the piece saver, like `repeatTarget`).
`ui.ladder: LadderUi | null` = `{ goal, step, start, failures, done }`: `start` is the speed when
the ladder was switched on (or the opening speed) and the floor for drops. New settings for a
ladder already on keep its `start` and `failures`. It acts only while Repeat mode is open;
closing Repeat keeps the setting.

In `#onRecord`, for a completed scored attempt (target = `repeatTarget ?? LADDER_DEFAULT_TARGET`):
a pass with streak ≥ target climbs to `min(goal, speed + step)` on the 5% grid
(`offsetOnGrid` in `ui/speed.ts`), or sets `done` at the goal; a failure counts, and
`LADDER_DROP_AFTER` (2) failures in a row drop to `max(start, speed − step)` (a no-op at the
floor). Any pass resets the failures; a finished ladder (`done`) does nothing more. A manual speed
change (`setSelection({ multiplier })`) resets the failures, lowers `start` below it and sets
`done` exactly when the new speed is at or above the goal. `lastResult.ladder` says what happened
(`climbedTo` / `droppedTo` / `done`); a climb keeps Repeat going (`targetReached` false).

The new speed waits for the Repeat reset (`#ladderNext`): the music finishes the passage at the
old speed, then `#ladderStep` changes the speed through `#select` (the `setSelection` path: saved
as `lastMultiplier`, new comparison context, the streak starts over) with the `ladder` flag, which
keeps the result card and its marks and prepares a fresh attempt at the new speed even though the
last one is `completed`; the strip wraps to the loop start. Any selection change before the reset,
or a seek to a lead-in (a new run), cancels the pending speed. Start or Again (`restart()`) while
the music still finishes is a new run: the pending Repeat reset is dropped and a pending speed is
applied at once through `#ladderStep` (`#newRunAtLadderSpeed`, only while the pass that announced
it is the engine's `completed` attempt), so the run's first attempt is prepared at the announced
speed (card cleared, streak 0, also in Keep time). Tests: `ladder.test.ts`, `PracticeSession.ladder.test.ts`.

## Keep time (rhythm mode, DECISIONS P13)

`setRhythmMode(on)` (saved on the piece as `rhythm` through the piece saver; `SessionOptions.rhythm`
opens with it) turns on Keep time: `ui.rhythm` true, `startAction` always `'scored'`
(`startPlan(…, { rhythm: true })`: over the loop in Repeat mode, else the whole piece from its
start; ordinary reading is not available). It needs a hand and a numerical tempo (refused
otherwise; with the hands off the setting stays and Start is Listen). Exclusive with play-through:
switching one on switches the other off. Switching either way ends an attempt in progress
('mode-change') and leaves the engine in ordinary reading, paused (off: at the attempt's current
position); the transport is rebuilt by the next Start.

Every scored attempt is then `transport: 'strict'` with `rhythm: { toleranceMs }` from
`settings.rhythm` (`#scoredKind`, also for Restart, Repeat resets, ladder steps and selection
changes that prepare a fresh attempt). The transport is the gated one of practice (silent with
both hands, the other hand automatic with one; its click per `metronome.keepTime`, below).

- **Count-in.** When the engine reaches Ready, `#beginCountIn` counts one bar (`countIn.ts`:
  the meter numerator at the passage start, compound numerators above 4 divisible by 3 in dotted
  beats, 4 beats without a meter; the beat from the tempo segment there ÷ speed). All clicks go to
  the metronome sink at once (accent first); Start loads the metronome for it even when both
  Metronome switches are off. `ui.countIn`
  counts the beats left (one timer per beat). At the end (`#endCountIn`) the engine's
  `startRunning(t)` and `transport.play(t)` get the same timestamp. Presses meanwhile are not judged
  (the engine ignores them in Ready). Leaving Ready (pause, seek, selection change, interruption,
  a new attempt) cancels it: the timer goes and the sink's `cancel(now)` drops its clicks.
- **Metronome (DECISIONS P20).** The count-in always clicks; the attempt after it clicks per
  `settings.metronome.keepTime` (default on: one steady pulse from the count-in into the music),
  everything else (Listen, reading, scored practice, play-through) per `metronome.enabled`.
  `metronome.ts` holds the pure rule: `metronomeScope(rhythm, hands)` ('keepTime' with Keep time on
  and a hand selected, else 'general'), `metronomeOn(settings.metronome, scope)` and
  `metronomePatch(scope, on)` (for `updateSettings`). The gated practice transport clicks per
  `#practiceClick()`; `updateSettings` applies either switch live to `#accomp`, `#listen` and
  `#play` (each by its own rule) and loads the module when a click is now wanted. Turning a click
  off cancels the sink, which also holds the count-in's beats: `#reclickCountIn` clicks the beats
  still to come again. `ui.metronomeScope` names the switch the current mode uses (the Practice
  menu's switch edits that one) and `ui.metronomeMuted` is true in play-through while the
  microphone follows (P16). The click is not assistance and is not recorded. Start
  (`#unlockAudio`) creates the shared AudioContext synchronously inside the tap when this Start
  will click (iPadOS starts one only in a user gesture; `#ensureMetronome` creates it after an
  await); nothing when no click is wanted, never throws.
- **Gates.** The music never waits. At the count-in's end every gate is released before
  `play`, so the transport never holds (releasing on arrival would re-anchor the music at each
  timer wake-up and let jitter accumulate); `onGateReached(i)` still reports
  `transportArrived(i, now)` and calls `releaseGate(i)` again, a harmless no-op. `input-complete`
  never releases a gate in strict mode (it would move the music ahead).
- **Feedback.** `missed` → the soft wash (`flash.hit(now, now + DEFAULT_WRONG_FEEDBACK_MS,
  { soft: true })`, with the damage-flash setting). `wrong` with reason
  `'late'` → the amber marker (`setEarlyMarker`) for `DEFAULT_WRONG_FEEDBACK_MS` (the engine records
  nothing for it, so the session times it; a tick clears it). `TimingDrift` takes the first matched
  attack offset from each strict `input-complete` event (U107). It updates the cue above the
  playhead after three consecutive drifting groups and clears it after two close to the beat,
  a miss, or a phase change. The frame calls `setTimingCue` on the current renderer.
  After the attempt the corrections (missed / late marks) and the result card show what happened.
  `lastResult.timing` = `{ groups, onTime, early, late, missed }` from `timingAccuracy(record)`.
- **Lifecycle.** Pause interrupts (scored); Start afterwards is a fresh attempt from the passage
  start with a count-in. Seeks interrupt, also during the count-in. Speed, hands and range changes
  prepare a fresh attempt as for gated attempts, so one in progress counts in again. Repeat: every
  pass (Repeat reset, Restart, Start, a ladder step) goes Preparing → Ready → count-in → running;
  the consecutive-pass target and the ladder read `record.passed` unchanged. Lead-ins (U38) are
  off: a seek in Repeat mode never sets one up; it interrupts an attempt, or while idle only moves
  the reading cursor, and the next Start begins at the loop start with a count-in. The playhead is
  not draggable while Keep time is on.
- **Settings.** A changed `settings.rhythm.toleranceMs` goes to the engine
  (`updateSettings({ rhythm })`), which interrupts an active strict attempt ('setting-change'); the
  interruption then reads "The Keep time tolerance changed, so the attempt stopped."
  `SessionSettings.rhythm` is optional (Study has no Keep time; absent = the engine default).

Tests: `PracticeSession.rhythm.test.ts` (manual clock, a recording metronome module),
`countIn.test.ts`, `metronome.test.ts`, `selection.test.ts`.

## Play-through (DECISIONS P12)

`setPlayThrough(on)` turns on a performance aid beside the engine, wired like Listen: Repeat mode
closes (the loop stays remembered, the cursor's repeat button hides), reading pauses at its
position and its transport goes, `ui.activity` is `'playing'`, `ui.playThrough` true and
`startAction` `'play'` (`startPlan(…, { playThrough: true })`: the reading blockers, never a
scored one). Start builds `#play`: a gated transport over the whole piece
(`transportGates(timeline)`, silent with both hands, the other hand automatic with one) and a
`PlayFollower` (`core/engine/follow.ts`) at the first group at or after the cursor.
`onGateReached(g)` → `follower.transportArrived(g, now)`; follower `release` events →
`transport.releaseGate(g)` (re-entrant through a fast-forward, tolerated by `#processPlay`).
While `#play` exists every human event goes to `follower.input` instead of the engine (the hint
pedal → `revealAtCursor()`), the patience deadline joins `#scheduleTick`, and `#framePlay` draws
the follower's group (targets, accepted marks, the amber tint for wrong presses, never the red
marker, pulse or cue), the transport position, the guide and the resume position. Pause / Resume
freeze and re-anchor the patience clock; seeks keep playing from the first group at or after the
position; browsing holds until the release (U95); speed applies live; new hands rebuild the transport at the same group;
the range end leaves it idle at the end (the next Start begins at the start of the piece). The
engine records nothing while the mode is on. Turning it on first records the reading pass so far
(a paused reading engine is reconfigured on its keep-progress path and drained while the mode is
still off); what the engine ends during play-through, and when it goes off, stays unrecorded. Off:
`#play` goes and the engine seeks to the follower's group, so reading continues there. Tests:
`PracticeSession.play.test.ts`.

### Through the microphone (DECISIONS P15, P16, P22)

What a play-through follows (`#followsMic`): the microphone when no piano input is connected,
and with one when `settings.mic.follow` (the Practice menu's Follow choice) is on, provided
`deps.createMicFollower` exists and `deps.micSupported?.()` is not false (`#micPossible`).
`#micActive` (it follows and a hand is selected) makes the play-through **silent for any hand**:
`#playSilent` builds the transport with no events and no output, so one hand needs no verified
output, and `#playMetronome` keeps the click silent (`ui.metronomeMuted`). `#startPlay` opens the
microphone (`#startMic`, with the selected hand: the follower then listens for that hand's
groups, which are the play timeline's; the browser may ask; a refusal leaves play-through on but
not playing, the reason in `ui.micStatus`, and the next Start asks again) before `#playFrom`.
The follower reports each time it hears the player at a new onset group; `#onMicEstimate` maps a
report with confidence ≥ 0.5 to `groupReached(timeline, position)` and calls
`follower.audioReached(g, now)` for the current group or later, so `#processPlay` releases the
gates up to it (a report behind the cursor, the player repeating a bar, changes nothing).
`#playFrom` resets it to the current group and resumes it (it listens afresh), `#pausePlay`
pauses it, `#seekPlay` resets it, `#disposePlay` closes it (`#disposeMic`); new hands rebuild
the play-through and reopen it for them. A speed change is not passed on: the follower follows
the order of the notes, not time. While the microphone follows, MIDI notes never reach the
follower (`PlayThrough.mic`; the hint pedal still names notes). A microphone that stops by
itself (`onLost`: unplugged, a failing worker) pauses play-through with the reason in
`ui.micStatus` (`#onMicLost`); the next Start opens it again.

**No piano (P22).** `#playRequired` (no input and a hand selected) keeps play-through on and
locked (`#syncPlayMode` after a selection or input change; `setPlayThrough(false)` is refused;
`ui.playThroughLocked`), refuses Repeat (`setRepeatMode(true)`, `repeatFrom`) and Keep time
(`setRhythmMode(true)`); Keep time switched off by it is not saved (`#rhythmHeld`) and comes back
with the piano. Repeat closed by it (`#setPlayThrough(true)` while play-through is required) is
not saved either (`#repeatHeld`, U98: the piece keeps `repeatOpen: true`, the loop stays
remembered); when the piano returns (`setInputAvailable(true)`, after `#syncPlayMode`, before
Keep time's return) Repeat reopens over the loop, paused at its start, unless play-through stayed
on by the learner's choice or there is no loop, when `repeatOpen: false` is saved instead. The
hold ends whenever Repeat opens and when the loop is cleared; the learner's own Play through with
a piano closes Repeat and saves it closed. `#playThroughChosen` is the learner's own choice: when the piano returns,
play-through stays on only if they chose it. A change of source (a piano connecting or leaving,
the Follow choice) pauses a started play-through and drops it (`#syncFollowSource` →
`#disposePlay(true)`), so the next Start rebuilds it for the new source; a piano unplugged while
the microphone already follows changes nothing. The hands are held (U27) only when neither a
piano nor a microphone is possible (`#syncHeldHands`). `startPlan` gets `hasInput`,
`micSupported` and `mic` (`#micActive`). `ui.follow`, `ui.pianoConnected`, `ui.micSupported`
and `ui.playThroughLocked` drive the menu's Follow row. Tests: `PracticeSession.mic.test.ts`.

## Tests

`PracticeSession.test.ts` (reading, scored lifecycle, repeat readiness, Repeat mode and the
cursor repeat button, loop wrap, interruptions, disconnect, continuous timing for both hands,
gate waiting, early grace and the soft early feedback, octave and accidental cues, background
playback, Listen,
Auto sound destination, hints, persistent-label exposure and fades, keyboard guide and
assistance, naming, no per-event UI publication), `guide.test.ts`, `labels.test.ts`,
`selection.test.ts`, `persistence.test.ts`. `npx vitest run src/app/session`.
`PracticeSession.cursor.test.ts` covers starting and resuming from browsed notation, restoring
page following, Repeat/Listen bounds, and seeks while browser sounds load.

## Decisions

See DECISIONS P2–P8 (proposed in the WP10 report): accompaniment allowed with browser sound;
zoom/orientation never interrupt (P5 revised); seeks
ignored while a scored attempt is preparing/ready; Preview interrupts a scored attempt;
leaving the view is a user stop.
