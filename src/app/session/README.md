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
| `new PracticeSession({pieceId, model, mode, selection, settings, startPosition?, repeatTarget?, ladder?, repeat?}, deps)` | One session per opened piece, in its mode. Opening saves nothing. |
| `openingMode(piece, env, practice?)`, `learnerHands(hands)`, `isPractice(mode)` | How a piece opens (`openingMode.ts`, below): its mode and hands; Wait and Keep time are practice. |
| `LADDER_DEFAULT_TARGET`, `LADDER_STEP` | Speed ladder constants (3 passes per rung without a Repeat target and the 5% step the screen sets). |
| `practiceModel(model, userTempo)` | Applies a user-supplied tempo (`withUserTempo`) when the score has none. |
| `selectionTimeline`, `startPlan(timeline, selection, mode, ctx)`, `passageSummary`, `rangeText`, `tempoText`, `clampPassage`, `HAND_TEXT` | Selection helpers (timeline, plain-language blockers, "Right hand · Bars 5–8 · 80% (♩ = 58)"). |
| `PersistentLabels`, `labelSnapshot`, `mergeOpacity` | Persistent label texts, eligibility and fades; engine label snapshot (`rulesJson = JSON.stringify(labels.rules)`). |
| `accompanimentAllowed`, `hasSoundOutput` | Output rules (`output.ts`: `playbackDestination` resolves Auto / Connected piano / Browser sound; graded accompaniment needs browser sound or a verified echo-free MIDI output). Where only that is missing, `ui.otherHand` names the places the view may ask about (`otherHandSound`, U149); Start stays refused. |
| `createPieceSaver(write, timers)` | `updatePiece` writes, coalesced (one in flight); debounced unless `immediate` (learner changes, pause/seek/hide). |
| `Store` / `ReadonlyStore` | Tiny observable used for the view stores. |
| `repeatedMistakes`, `repeatedMistakeLine`, `REPEATED_MISTAKE_PASSES`, `RepeatedMistake` | Repeated mistakes (`mistakes.ts`, P24, below). |
| `PassRecord`, `RunRecord` | A pass the result card can show: a scored attempt, or a finished Wait run (`run.ts`, U142, below). |

### `PracticeSession`

Controls: `setMode(mode)` (below), `togglePlay()`, `start()` (what the mode says), `pause()`,
`restart()`, `resume()`, `seek(occ)`, `seekPosition(pos)`,
`again()` (the result's Again: a Wait run from where it started, else `restart()`), `loopRoughBars()`
(its Loop action, below), `requestHint()`, `setKeyboardVisible(v)`, `setRepeatMode(open, at?)` (saved on the piece as `repeatOpen`, U98; `SessionOptions.repeat` opens
with it on over `selection.range`, clamped), `repeatFrom(occ)` (a fresh
one-bar loop), `repeatAtCursor(occ?)` (the cursor's repeat button: pauses what plays, then opens
Repeat at the bar the button was over: `occ` when the view reports one, else the
cursor's bar), `setChromeRevealed(bool)` (the view's chrome is revealed, not in
focus mode; default true), `setInputAvailable(bool)` (a piano input is connected), `setRepeatTarget(n)`,
`setLadder(ladder | null)` (speed ladder, below), `dismissResult()`,
`setSelection({hands?, range?, multiplier?})` (hands are always both, left or right), `updateSettings(settings)`,
`beforeApplyLabels(next)` (register with `onBeforeApplyLabels`), `layoutChanging()`
(re-prepare), `viewChanged()` (zoom / orientation; never interrupts, P5 revised), `suspend()` (save progress when hidden without pausing), `dispose()`.
Strip: `attachStrip(strip)`, `detachStrip()`, `attachFlash(handle)`, `onVisibleLabels(added)`,
`browseStarted()`, `browseReleased()` (U41, U95). `revealAtCursor()` names both hands' notes at the
cursor for the hint lifetime (`REVEAL_FALLBACK_S` when hints last until the correct note), fading
over `hints.fadeMs`; it is a third label-opacity source merged with the persistent and temporary
ones, independent of any attempt (U72).

### Modes

`PracticeMode` = `'listen' | 'wait' | 'time' | 'follow'` (`core/model/practice.ts`): the learner's
explicit choice. `setMode` is the only thing that changes it: no piano coming or going, hands,
Repeat, speed or setting does. `ui.mode` and `ui.hands` publish it and the hands (the ones the
learner plays; in Listen, the ones they hear).

| Mode | Start (`ui.startAction`) | Needs | Records | Saved position |
| --- | --- | --- | --- | --- |
| Listen | plays the chosen hands (`'listen'`) | a sound output | nothing | untouched |
| Wait | reading, or a scored attempt over the loop in Repeat (`'reading'`, `'scored'`) | a piano | yes | as below |
| Keep time | a count-in and a scored attempt (`'scored'`) | a piano | yes | as below |
| Follow | follows the playing (`'play'`) | a piano or a microphone | nothing | untouched |

`setMode(mode)` stops what the old mode does (`#leaveMode`), keeps the cursor (`#cursorOnset` →
`#placeCursor`) and starts nothing:

- **Leaving.** A Start still loading sounds or opening the microphone is canceled (`#startGen`) and
  forgotten (`#starting`), so a Start in the new mode never waits for it (the browser may be asking
  for the microphone). A browse hold ends as a Pause. Wait and Keep time cancel the count-in, hand
  on a finished Keep time pass (`#releaseKeepTime`), save the position of a running reading, and end
  the attempt or reading pass with `'mode-change'`, recorded while the mode is still theirs;
  `#leaving` keeps a pass that completes on the way out (P24's last chord) from preparing the next
  one. The practice transport, Listen's and Follow's go, and the microphone with Follow's. The result
  card, its marks, its review, the snippet playing in it, the cue and the flash go too. The output
  backend stays loaded, silent.
- **The cursor** is the next onset of the current hands at or after it: the music's position, not the
  engine's target. Past the last one it is the start (of the loop in Repeat). The engine waits there
  in paused reading, whatever the mode; `activity` is `'idle'` (`'playing'` in Follow). With Repeat
  open, Wait sets up a lead-in from anywhere but the loop's first stop, as a seek does (U38); Keep
  time rests anywhere on the score (U128) while its Start still uses the loop; Listen stays in the
  loop. A browsed strip stays browsed, and the next Start adopts its note (U52). Nothing is saved as
  the resume position by the change itself.
- **Repeat in Follow** is put away (`ui.repeat` false, `ui.range` null, no cursor button; opening it
  is refused) and comes back as it was when Follow is left (`#repeatAfterFollow`); the piece keeps
  `repeatOpen` meanwhile. `SessionOptions.repeat` in Follow means the same. A loop cleared meanwhile
  stays cleared.
- **Saved** at once: `{ mode, lastHands }`. Hands, speed, loop and Repeat are saved in every mode.

`openingMode(piece, { pianoConnected, pianoRemembered, midiSupported }, practice?)` is the mode a
piece opens in: the stored one; else Keep time for an older record's `rhythm: true`, Listen for its
`lastHands: 'none'`; else Wait with a piano connected or remembered, Listen without. Without Web MIDI
Wait and Keep time open as Listen, unsaved. `practice`: opened to practice a given passage, so Listen
and Follow open as Wait. `learnerHands` reads an older `'none'` as both.

**The piano away.** `setInputAvailable(false)` only blocks Start in Wait and Keep time ("Wait needs a
connected piano.", before any other reason) and turns Follow's source to the microphone. The mode,
the hands and Repeat stay, and all can be changed. A run in progress ends as a disconnect
(`#loseInput`, from the route event, or from the status alone when a run still plays): the scored
attempt or reading pass is interrupted once, and reading resumes with Start once the piano is back
(U42). Listen plays on; Follow pauses unless the microphone follows.

Loop changes while Repeat plays (U94, `#select`): a `range-change` while the main button shows
Pause (or a browse hold waits) keeps playing. `#continueFrom()` reads where playback is, exact,
before anything changes (the next note of a running attempt or lead-in; the onset at or after the
cursor for Listen or music playing on; null at Ready). Listen rebuilds its transport over the new
loop from there when it lies inside it, else from the loop start (`#replayListen`). In Wait and Keep
time, the attempt in progress ends as 'range-change', then `#seekLeadIn(from, now, {play: true,
reason})` plays a lead-in from a position inside the new loop (or before it, when a lead-in was
reading toward the loop), and otherwise the next attempt waits at the loop start at Ready (Keep
time always; an attempt still at Ready too). Paused, a loop change only moves the loop.

Browsing only looks elsewhere in both views (U151; `browsedPosition()` null while browsing): nothing pauses
or is discarded, and `browseReleased()` (`StripOptions.onBrowseRelease`, the strip only: the gesture and its
glide are over) makes the view follow again while something plays. The hold described next serves a view that
does report a browsed position; none does now.

Browsing (U41, U95): `browseStarted()` (the view's `onBrowse(true)`) while something plays (Pause
showing, Ready and a finished pass's music included) pauses it and discards the attempt or reading
pass in progress, and records a hold (`#browseHold`, with `#continueFrom()`); `ui.playing` stays
true during the hold. `browseReleased()` (`StripOptions.onBrowseRelease`: last finger up or
canceled, 250 ms wheel idle, or a handle drag that scrolled) then calls `start()`, which adopts the
browsed note as below. Any Pause (`pause()`, an overlay, a lost input or output, `detachStrip`,
`dispose`) or a Start ends the hold; a loop change during it resolves it by U94 and calls
`returnToCurrent()`. The page layout (`browsedPosition()` null while browsing) pauses nothing.

Start adopts the notation's optional `browsedPosition()` before resuming playback, then calls
`returnToCurrent()` to restore cursor following. Both views return null because their cursor
already marks the session position. This is checked again after sound loading so a later browse or seek wins.
Reading and scored lead-ins use the existing seek rules. Listen honors the selected onset
inside its loop and keeps playback within that loop. A seek made while changing sound outputs
also replaces the paused Listen position captured before the new output finished loading.
A Start waits for sounds (`#ensureOutput`, `#ensureMetronome`, `#startMic`); afterwards it
re-reads the plan (the loop cleared, other hands) and starts nothing when a Pause or a mode change
came in meanwhile (`#startGen`, bumped by `pause()`: an overlay, browsing, Stop sound; and by
`setMode`), leaving the session as that did. A Start pressed again after such a
Pause runs once the canceled one has returned, unless another Pause came in by then; otherwise a
second Start joins the first.

Note-level loops and the draggable playhead (WP13, DECISIONS U19, U21–U23): `selection.range` /
`setSelection({range})` accept `PassageRange` with exact `start` / `end` (normalized by
`clampPassage` = `normalizePassage`: edges on a barline are dropped). `seekPosition(pos)` returns
whether the position was taken (false in a scored attempt, P6) — the strip's dragged playhead
(`StripOptions.onCursorSeek`) lands on a note and reading continues there; Listen and Follow seek
their transport. `snapOnsets` is the hands' onset list (cached per hand selection) handed to
`strip.setSnapPositions`; `strip.setCursorDraggable` is on
while paused or idle outside Repeat mode (never in Repeat mode, where every pass starts at the
loop start). The cursor's repeat button (`strip.setCursorAction(visible)`) shows outside Repeat
mode and Follow only: `!repeat && (!playing || chromeRevealed)`, so while playing it goes with focus
mode (U14). When a Repeat pass starts over, `strip.wrapTo?(loopStart)` lets the strip pan back fast.

Lead-in (Wait, Repeat mode): `seek(occ)` to any bar but the loop's first bar, or `seekPosition(pos)`
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

Teacher corrections (`corrections.ts`): when a scored attempt completes, or a Wait run ends (U142),
`correctionMarks(record, timeline, model, settings.naming)` turns the record's per-group outcomes into one mark per group
with a problem, the first of: a wrong pitch one semitone from a required pitch on its letter
(`'accidental'`, "F♯, not F": the target spelled as the score does, accidental always shown, the
naming settings honored), a wrong pitch 12 or 24 semitones from one (`'octave'`, "Wrong octave ↑"
/ "↓" toward the right one), another wrong key (`'wrong'`, "Wrong note" / "Wrong notes"), a
re-attacked tie end (`'tie'`, "Tied, hold it"), a non-rolled chord of two or more pitches spread
over `SPREAD_MARK_MS` (90 ms) or more (`'spread'`, "Together"; a group with a note carrying
`PerformedNote.arpeggio` never gets `'spread'`), a right pitch too early ("Too soon"),
completed at least `LATE_MARK_MS` (350 ms) after the music reached the gate ("Too late"). Outcomes
without the newer optional fields (older records) give only the older classes. A mark's notes are
the group's note indices whose onset lies inside the attempt's passage (`passageBounds`; a tie
head before the loop start is never ringed; a mark with none left is dropped), handed to
`strip.setCorrections?(marks)`; `ui.corrections` is their count. A `wrong` event with reason
`'tie-end'` contributes only to the review.
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

**Wait run (U142, `run.ts`).** Outside Repeat, what is read in Wait is one run from its first note
until the piece's last group completes, whatever traversals the engine makes of it (seek, speed
change, browsing, disconnect). `#addToRun` folds each ended traversal in (`addTraversal`, pure): per
group the latest time it was played wins (completed, or tried with a wrong key and left; a group only
reached keeps what it had), and the groups never played are not counted. `#visit` numbers the stretches
without a jump; a speed change goes on with one, so the group it split is added up, not replaced.
Nothing runs per key press and what is kept is bounded by the piece's groups. A traversal dropped from
the history by browsing (U41) still belongs to its run. Other hands, another mode, Repeat, Restart and
Again give the run up (`#dropRun`); reading that goes on after other hands is a run of its own.
`#finishRun` makes the `RunRecord` (`kind: 'run'`: wrong notes, first-try and total places over the kept
groups, `passed` without wrong notes, whatever the help, U144; no time, no streak) and shows
its result as a pass's (`#showResult`): the pill, the marks, the card, the repeated-mistake check. It is
in memory only: the traversals go to the history as ever and the run is never stored (`lastResult.run`).
The tail plays and the piece rewinds (U126) with the pill up; opening the details ends the tail. Start
clears the marks and leaves the pill to U101: the run's first correct note dims it, leaving that bar
ends it. The review is for loops only (`#sel.range`).

**Rough bars (U142, `rough.ts`).** Outside Repeat the next UI publish also works out
`lastResult.rough` for a Wait run or a Keep time pass (`roughPassage`): each bar weighs its wrong
attacks and missed groups (in Keep time a right key too early is timing and weighs nothing), the
heaviest run of adjacent bars (the earlier of equals) is cut to its heaviest `MAX_CORE_BARS` and gets
its context bars. Absent without any, and when it would be the whole run. `loopRoughBars()` pauses,
opens Repeat over them in the same mode, paused at their start, and starts nothing. Tests:
`run.test.ts`, `rough.test.ts`, `PracticeSession.run.test.ts`.

The review (U97) begins when a completed loop's result appears. `#syncReview` calls the optional
`strip.setReview?(on, returnBy)` from the session frame and on `attachStrip`. The review ends on
the first correct note in waiting practice (U101), on count 2 in Keep time (U103), or when the
result is dismissed. Keep time sets `#reviewReturnBy` at the last two count-in beats and passes
the downbeat as the deadline for the strip's zoom. The deadline also keeps review off for that
result until the next pass completes. `openResultDetails` pauses the session if another Keep time
pass is pending, preparing, or counting in, restoring the review frame for that result. Starting
again counts in from the beginning. A reattached strip receives the current review state.
The card's note line is the first of `lastResult.repeatedMistakes`, worded by the view (below).

Repeated mistakes (`mistakes.ts`, DECISIONS P24): `#rememberPass` keeps the last
`REPEATED_MISTAKE_HISTORY` (8) passes (scored records, Wait runs) of the current comparison context
(cleared when it changes); a completed one is marked pending with the timeline it ran on. Scored
records are also queued for the mistake memory (P38): `SpotMemory` (`#spots`, one per hand
selection) folds them in the next frame, never in the input path, and `seedSpots` folds the piece's
stored attempts on the session's timers, in time order, without arming the guard. The frame syncs
`engine.setGuard(mem.guardFor(tl), tl)` in non-strict scored mode. The next UI publish works out
`repeatedMistakes(latest, timeline, model, spots)` from each place's visits (`#spotsByGroup`: the
memory's for a scored pass, the runs before it for a Wait run, `runVisits`) and sets
`lastResult.repeatedMistakes` (absent when none): the same wrong pitch at the same group in
`REPEATED_MISTAKE_PASSES` (3) passes running, the latest included, surviving speed changes, ladder
steps, Restart, abandoned passes and shifted loop edges, most passes first. Each `RepeatedMistake` =
`{ group, occ, bar, expectedPitches, expectedPitch, expectedNote, wrongPitch, passes, together? }`;
`expectedPitch` / `expectedNote` is the required note the key most likely stood for (same letter a
semitone away, else an octave away, else the nearest). `repeatedMistakeLine(m, model, naming)` words
it for the result card's note line (the view calls it on render, U97): "F instead of F♯ in bar 12,
three passes running", or "F with F♯ …" when struck with the right keys (score spelling with its
accidental, ♮ against the same letter, octave numbers only for a wrong octave, counts in words up to
ten). Recurring wrong-key marks get `repeat` (≥ 2): a double ring with "×N". `resultDetails()`
returns `spots` and `fixed` (places clean now and wrong last visit) besides the marks.
`canDrill` / `drillSpot` / `endDrill` (U168, `drill.ts`) start and leave a drill of one place
(target 3 clean, ladder suspended, never saved as the loop, `ui.drill`); a hand, loop or Repeat change
of the learner's ends it the same way, and a target or ladder chosen meanwhile is kept.
`#syncReminders()` (U167) pushes up to 24 highlighter reminders (`StripSink.setReminders`, `firm` first then
score order) from `SpotMemory.hotSpots` only when `hints.reminders` is on, the engine is scored outside
Follow and Listen, and no review is showing. `pauses.ts` (`pauseThresholdMs`: half a beat clamped
250–600 ms, `pausedGroups`) drives gated "Too late" marks, the ladder's fluent-only streak
(`#ladderStreak`, `ladder.held` on clean passes with pauses, P40) and the `hesitation` ranking level.
`causes.ts`, `patterns.ts` and `ranking.ts` load with the card. Chord slips (P24) reach the session as
`wrong` events of the group just completed: they flash and pulse like any wrong key, but no cue is
computed (the cue points toward the current group). `SessionDeps.finalSlipMs` (default
`CHORD_SLIP_MS`) is the engine's final-chord hold; the test harness passes 0 so scenario tests see the
record at the final key. Tests: `mistakes.test.ts`, `causes.test.ts`, `patterns.test.ts`,
`pauses.test.ts`, `drill.test.ts`, `PracticeSession.mistakes.test.ts`, `PracticeSession.spots.test.ts`,
`PracticeSession.drill.test.ts`, `PracticeSession.reminders.test.ts`;
`PracticeSession.required.test.ts` sweeps one-hand presses through the session (P23).

The next waiting-practice Repeat pass calls `engine.restart(now, { continueRepeat: true })`
(P26) and keeps the session's `setGuard` active across speed and loop changes (P38). A recurring
extra key keeps the transport at that onset and clears accepted notes there; when pressed alone,
the first clean stroke is taken back (P39). The feedback store publishes `{ kind: 'retry' }`
("Try again") and switches to `{ kind: 'once-more' }` ("Once more") while `engine.state.onceMore`
is true.

Stores (subscribe from the view):

| Store | Changes | Consumers |
| --- | --- | --- |
| `ui: SessionUi` | phase/selection/coarse status only (published from the frame, shallow-compared; `countIn` once per count-in beat) | the screen |
| `progress: {position, occ}` | ≤ once per frame | `ScoreOverview`, `LoopSteppers` |
| `feedback: {visible, reason, pulse, cue}` | ≤ once per frame | `StageCue` at the cursor: `{kind: 'octave', direction}`, `{kind: 'accidental', text, accidental}`, `{kind: 'retry'}` or `{kind: 'once-more'}` |
| `guide: {keys, rollDirection}` | ≤ once per frame while the guide is visible, only when a key changed (`guide.ts`) | `KeyboardGuide` |

## How it works

- **Input path (O(small)).** `midi.subscribe` → `midiBackend.humanInput(ev)` (human-held
  release guard) → optional browser monitoring → `engine.input(ev)` → drain engine events.
  Draining releases transport gates (`input-complete` → `releaseGate`) synchronously, queues
  records (`history.queueAttempt/queueAbandon`, O(1)) and schedules **one** animation frame.
  Nothing in the input path renders, writes storage or touches the DOM. Tested: a burst of
  five presses produces 0 `ui` emissions before the frame and ≤ 1 `progress` emission.
- **Frame.** On engine `state.version` change: `setTargets / setAccepted / setOttavaEmphasis`
  and the correction cue. Loop editing, browsing and the strip's
  cursor repeat button (`setCursorAction(visible)`, outside Repeat mode while paused or while the
  chrome is revealed) follow the state. The keyboard guide (`buildGuideKeys`: targets, held and wrong keys, and what playback
  sounds, named with the naming settings) is rebuilt on a version or playback-highlight change
  while it is visible. Wrong attacks since the last frame trigger `flash.hit(now, wrongFeedbackUntil)`
  when enabled. An early press of the right pitch uses `{ soft: true }` (P3).
  Labels: `engine.temporaryLabelOpacity(now)` merged with persistent opacity by max →
  `setLabelOpacity` only when either changed. The cursor = the transport's `positionNow()` once there is one;
  sounding keys from `onEmit` events update the keyboard guide at their scheduled times.
  Frames run for label fades, a moving transport, and pending guide events.
  A practice gate stops the flow until all required pitches have been played; accepted early
  presses never move the score ahead of musical time. Wrong-octave attacks choose the nearest
  missing pitch of the same pitch class (equal distances favor the lower pitch) → an octave cue.
  A key one semitone from a missing pitch on the same letter (F for F♯; F♯ / G♭ for F♮ or G♮)
  → an accidental cue naming the target as the score spells it, with the naming settings and its
  accidental always shown (♮ for a natural). Unrelated errors and early timing errors clear the
  cue, as do accepting its target pitch and lifecycle changes.
- **Ticks.** One timer at `min(engine.nextDeadline(), hint fade start, persistent fade end)`
  → `engine.tick(now)`. A tick that fires more than 8 ms late re-queues itself once with a zero
  delay so key events already queued are handled first.
- **Wait** (DECISIONS P1): no passage → ordinary reading (Start resumes from the current
  position, Pause keeps progress); passage → scored attempt (Preparing → Ready → Running →
  Completed; Pause interrupts). Wait and Keep time use a gated
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
- **Whole-piece finish.** With Repeat off, the transport stops at the end of the written
  tail and resets to position zero. The session asks the renderer to glide back to the
  opening. Every mode waits for Play or Start.
  The completed Keep time result remains available.
- **Interruptions.** Pause (scored; no banner, the main button reads Start), seek while running,
  hands/range/speed change (new attempt prepared when still allowed), label mode/rule
  (`beforeApplyLabels`), layout (`layoutChanging`; zoom and orientation never interrupt), opening
  an overlay (`holdInput` pauses), input/output
  disconnect (`onRoute`; reconnect → `resetPhysical` + `resetHuman`), Stop sound (registered
  owner), leaving the view (`user-stop`; a paused reading pass, also under an overlay, ends with
  `'suspend'`, so it is recorded without an abandon event). Reading interruptions offer Resume / Restart. Hiding
  the page only saves progress: it does not pause practice, Listen, or their transports.
- **Persistence.** `mode` with `lastHands` on a mode change, `lastHands/lastPassage/lastMultiplier`
  on selection change, `repeatOpen` (Repeat mode on, DECISIONS U98) whenever Repeat opens or closes
  and `false` with `lastPassage: null` when the loop is cleared: in every mode. Mode, hands, speed,
  loop, Repeat mode, `repeatTarget` and `ladder` are written at once (taps and drags, never the MIDI
  path; a reload right after must find them) and coalesced by the saver; only the ladder's own speed
  step (from the MIDI path) and the periodic resume position are debounced. `resume` in Wait and Keep
  time only (`#saveResume`; U72: looking at a piece never moves the practice place), on
  pause/seek/hide/dispose and every ≥ 5 s of reading (from the frame, never per event); cleared at the
  end of the piece. Attempts, traversals and abandon events come from those two modes only. The last
  result, corrections and streak are never saved: a session opened with
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
  the next Start continues through the device. The Web Audio metronome and count-in follow system
  audio or the audio device selected under Metronome in Settings (U114).

## Speed ladder (Repeat mode)

The metronome-ladder technique, automated (`ladder.ts` holds the pure rules, the session applies
them). `SessionOptions.ladder` / `setLadder(LadderSettings | null)` set it (`{ goal, step }`,
speed multipliers; saved on the piece as `ladder` through the piece saver, like `repeatTarget`).
`ui.ladder: LadderUi | null` = `{ goal, step, done }`. It acts while Repeat mode is open, and
closing Repeat keeps the setting.

In `#onRecord`, for a completed scored attempt (target = `repeatTarget ?? LADDER_DEFAULT_TARGET`):
a pass with streak ≥ target climbs to `min(goal, speed + step)` on the 5% grid
(`offsetOnGrid` in `ui/speed.ts`) or sets `done` at the goal. A failure resets the clean
streak at the current speed. A manual speed change (`setSelection({ multiplier })`) sets
`done` when the new speed is at or above the goal. `lastResult.ladder` says what happened
(`climbedTo` / `done`). A climb keeps Repeat going (`targetReached` false).

The new speed waits for the Repeat reset (`#ladderNext`): the music finishes the passage at the
old speed, then `#ladderStep` changes the speed through `#select` (the `setSelection` path: saved
as `lastMultiplier`, new comparison context, the streak starts over) with the `ladder` flag, which
keeps the result card and its marks and prepares a fresh attempt at the new speed even though the
last one is `completed`; the strip wraps to the loop start. Any selection change before the reset,
or a seek to a lead-in (a new run), cancels the pending speed. Start or Again (`restart()`) while
the music still finishes is a new run: the pending Repeat reset is dropped and a pending speed is
applied at once through `#ladderStep` (`#newRunAtLadderSpeed`, only while the pass that announced
it is the engine's `completed` attempt), so the run's first attempt is prepared at the announced
speed (card cleared, streak 0, also in Keep time). `ladderAfterAttempt(..., fluent)` and
`note.held` (a clean pass with pauses holds the speed, neither a climb nor a failure) are added
in `ladder.ts`, not yet passed by the session. `drillRange` (`drill.ts`: a loop from two onsets
of the selected hands before a spot to the end of the onset after it) is also added, not yet
used by the session. Tests: `ladder.test.ts`, `PracticeSession.ladder.test.ts`.

## Keep time (DECISIONS P13)

Mode `'time'`: `startAction` is always `'scored'`. Start counts in at the loop start in Repeat mode
or at the visible cursor in the whole piece. It needs a numerical tempo (without one the mode stays
chosen and Start says so). The transport is built by Start.

Every scored attempt is `transport: 'strict'` with `rhythm: { toleranceMs }` from
`settings.rhythm` (`#scoredKind`, also for Restart, Repeat resets, ladder steps and selection
changes that prepare a fresh attempt), plus `scorePlayback: true` while Playback (P27) is on above
0% (`#playbackHeard`: at 0% it plays nothing and counts as off, for the comparison context, the
Start plan's echo-free output and silent both-hands practice; raising the volume mid-pass is
switching it on mid-pass). The transport is the gated one of practice (silent with
both hands, the other hand automatic with one; its click per `metronome.keepTime`, below).

- **Count-in.** When the engine reaches Ready, `#beginCountIn` uses the opening meter and
  practice tempo (`countIn.ts`). The plan counts a full bar within five seconds or shortens it
  to the beats that fit. If a bar is too long and fewer than two beats fit, it uses two
  subdivisions. All clicks go to the metronome sink at once (accent first). Start loads the
  metronome for it even when both Metronome switches are off. `ui.countIn` counts the clicks
  left (one timer per click). At the end (`#endCountIn`) the engine's
  `startRunning(t)` and `transport.play(t)` get the same timestamp. Presses meanwhile are not judged
  (the engine ignores them in Ready), except the count-in's last stretch: presses from the planned
  downbeat minus the tolerance on (a ring of `COUNT_IN_PRESSES` = 16 on `CountIn`, no allocation
  per press) are the first downbeat played early, or on time before the count-in timer ran.
  `#replayCountIn`, once the transport plays, takes those from the music's downbeat (with its stall
  shift) minus the tolerance on and gives each, at its own time, to the first bar's silent-bar and
  opening checks, the captured pass, the live timing cue and `engine.countInPress` (judged as a
  press at that moment of the pass). Every Repeat pass has its own count-in, so the next pass's
  downbeat is covered the same way. Leaving Ready (pause, seek, selection change, interruption,
  a new attempt) cancels it: the timer goes and the sink's `cancel(now)` drops its clicks.
- **Metronome (DECISIONS P20).** The count-in always clicks; the attempt after it clicks per
  `settings.metronome.keepTime` (default on: one steady pulse from the count-in into the music),
  everything else (Listen, Wait, Follow) per `metronome.enabled`.
  `metronome.ts` holds the pure rule: `metronomeScope(mode)` ('keepTime' in Keep time, else
  'general'), `metronomeOn(settings.metronome, scope)` and
  `metronomePatch(scope, on)` (for `updateSettings`). The gated practice transport clicks per
  `#practiceClick()`; `updateSettings` applies either switch live to `#accomp`, `#listen` and
  `#play` (each by its own rule) and loads the module when a click is now wanted. Turning a click
  off cancels the sink, which also holds the count-in's beats: `#reclickCountIn` clicks the beats
  still to come again. `ui.metronomeScope` names the switch the current mode uses (the menu's
  switch edits that one) and `ui.metronomeMuted` is true in Follow while the microphone follows
  (P16). The click is not assistance and is not recorded. Start
  (`#unlockAudio`) creates the shared AudioContext synchronously inside the tap when this Start
  will click (iPadOS starts one only in a user gesture; `#ensureMetronome` creates it after an
  await); nothing when no click is wanted, never throws. Overlapping `#ensureMetronome` calls (a
  switch flipped while Start loads) queue behind each other, so each returns with a metronome and
  the count-in's clicks always have one to go to.
- **Gates.** The music never waits. At the count-in's end every gate is released before
  `play`, so the transport never holds (releasing on arrival would re-anchor the music at each
  timer wake-up and let jitter accumulate); `onGateReached(i)` still reports
  `transportArrived(i, now)` and calls `releaseGate(i)` again, a harmless no-op. `input-complete`
  never releases a gate in strict mode (it would move the music ahead).
- **Feedback.** `missed` → the soft wash (`flash.hit(now, now + DEFAULT_WRONG_FEEDBACK_MS,
  { soft: true })`, with the damage-flash setting). `TimingDrift` takes the first matched
  attack offset from each strict `input-complete` event (U107). Three consecutive drifting
  groups show a cue. A feedback-only match to an onset within a second of the playhead or the
  player's next written onset outside the tolerance shows it immediately (U111, U113).
  The pitch index is prepared before the count-in; each press is matched after taking off the
  transport's stall shift (`Transport.shiftMs`: a late count-in timer or a main-thread stall moves
  the music later, and the engine grades against its real arrivals). A miss clears the scored
  trend. The cue clears after two attacks near the beat or a phase change, and an out-of-window
  cue expires after 1.2 s. The frame calls `setTimingCue` with the direction (while running) and
  whether the cue row is reserved (`#timingRowEnabled`: `hints.showTimingCues`, not Listen, not the
  microphone in Follow), whatever the phase (U122), so the score never
  shifts on Start, Pause or a new pass; `attachStrip` sets the row before anything else. The
  playhead uses blue or amber while the timing label is visible. The renderer
  places the label near the playhead and falls back to the top
  margin when surrounding notation leaves too little space (U120).
  After the attempt the corrections (missed / late marks) and the result card show what happened.
  `lastResult.timing` = `{ groups, onTime, early, late, missed }` from `timingAccuracy(record)`.
- **Unattended stop (DECISIONS U112).** `#watchKeepTimeActivity` turns each playable bar into a
  window from the downbeat. A press at t counts for every bar k with t in [start k − tolerance,
  end k) (the attempt's tolerance: an early downbeat counts for its own bar and the one it fell
  in; one in the count-in's last stretch counts for the first bar), compared after the
  transport's stall shift. A bar is judged a grace after its end (`SessionDeps.keepTimeGraceMs`,
  default `KEEP_TIME_GRACE_MS` = 100 ms: a key stamped before the barline but delivered after
  the bar-end timer still counts; the harness passes 0); an unplayed one, or a Repeat opening
  with no learner pitch from the first bar's early start to its end, pauses and drops the pass
  (`#stopInactiveKeepTime`). A completed record waits in the activity while a bar left could
  still be silent. Every other way of leaving the pass (pause, seek, selection or mode change, a
  lost input or output, Again, leaving the view) records it first (`#releaseKeepTime`, with no
  Repeat reset after it), unless the Repeat opening check is still pending (`#openingPending`: no
  sign of a player yet; in a one-bar loop's first traversal, whose check carries over, an unplayed
  bar): then it is dropped as the stop drops it, the previous result and its review back.
- **Lifecycle.** Pause interrupts (scored); Start afterwards is a fresh attempt from the
  start of the selected loop or the current playable onset with a count-in. Seeks interrupt, also during the count-in. Speed, hands and range changes
  prepare a fresh attempt as for gated attempts, so one in progress counts in again. Repeat: every
  pass (Repeat reset, Restart, Start, a ladder step) goes Preparing → Ready → count-in → running;
  the consecutive-pass target and the ladder read `record.passed` unchanged. Lead-ins (U38) are
  off. The header overview moves the paused cursor across the whole piece, including outside a
  selected loop; a speed change then returns the engine to the loop at its start. With Repeat closed, the playhead is also draggable while paused. A pass from the
  cursor (U128) that reaches the end rewinds everything to zero (U126: its transport, which
  stopped at the cursor, goes); Start then counts in from the top, Again from that pass's start.
- **Settings.** A changed `settings.rhythm.toleranceMs` goes to the engine
  (`updateSettings({ rhythm })`), which interrupts an active strict attempt ('setting-change'); the
  interruption then reads "The Keep time tolerance changed, so the attempt stopped."
  `SessionSettings.rhythm` is optional (absent = the engine default).

Tests: `PracticeSession.rhythm.test.ts` (manual clock, a recording metronome module),
`PracticeSession.keepTime.test.ts` (the unattended stop with the production grace, kept records,
stalls, the rewind, Playback at 0%, the cue row), `countIn.test.ts`, `metronome.test.ts`,
`selection.test.ts`.

## Follow (DECISIONS P12)

Mode `'follow'`: a performance aid beside the engine, wired like Listen. `ui.activity` is `'playing'`
and `startAction` `'play'` (`startPlan`: the reading blockers, never a scored one). Start builds
`#play`: a gated transport over the whole piece (`transportGates(timeline)`, silent with both hands,
the other hand automatic with one) and a `PlayFollower` (`core/engine/follow.ts`) at the first group
at or after the cursor. `onGateReached(g)` → `follower.transportArrived(g, now)`; follower `release`
events → `transport.releaseGate(g)` (re-entrant through a fast-forward, tolerated by `#processPlay`).
While `#play` exists every human event goes to `follower.input` instead of the engine (the hint
pedal → `revealAtCursor()`), the patience deadline joins `#scheduleTick`, and `#framePlay` draws
the follower's targets, accepted marks, the transport position and the guide.
Wrong presses trigger a soft edge flash when enabled. Pause / Resume
freeze and re-anchor the patience clock; seeks keep playing from the first group at or after the
position; browsing holds until the release (U95); speed applies live; new hands rebuild the transport at the same group;
the range end leaves it idle at the end (the next Start begins at the start of the piece). Nothing is
recorded and the saved position does not move. Tests: `PracticeSession.play.test.ts`.

### Through the microphone (DECISIONS P15, P16, P22)

What Follow follows (`#followsMic`, `ui.follow`): the microphone only when no piano input is connected
(P37), provided
`deps.createMicFollower` exists and `deps.micSupported?.()` is not false (`#micPossible`).
`#micActive` (Follow, through the microphone) makes it **silent for any hand**:
`#playSilent` builds the transport with no events and no output, so one hand needs no verified
output, and `#playMetronome` keeps the click silent (`ui.metronomeMuted`). `#startPlay` opens the
microphone (`#startMic`, with the selected hand: the follower then listens for that hand's
groups, which are the play timeline's; the browser may ask; a refusal leaves it not playing, the
reason in `ui.micStatus`, and the next Start asks again) before `#playFrom`.
The follower reports each time it hears the player at a new onset group; `#onMicEstimate` maps a
report with confidence ≥ 0.5 to `groupReached(timeline, position)` and calls
`follower.audioReached(g, now)` for the current group or later, so `#processPlay` releases the
gates up to it (a report behind the cursor, the player repeating a bar, changes nothing).
`#playFrom` resets it to the current group and resumes it (it listens afresh), `#pausePlay`
pauses it, `#seekPlay` resets it, `#disposePlay` closes it (`#disposeMic`), also one still opening
when the mode changes; new hands rebuild the transport and reopen it for them. A speed change is not passed on: the follower follows
the order of the notes, not time. While the microphone follows, MIDI notes never reach the
follower (`Following.mic`; the hint pedal still names notes). A microphone that stops by
itself (`onLost`: unplugged, a failing worker) pauses Follow with the reason in
`ui.micStatus` (`#onMicLost`); the next Start opens it again.

**The drawn cursor (U162).** `#processPlay` measures how far its releases moved the transport at once
and hands it to `Following.catchUp` (`CursorCatchUp`, a critically damped spring in whole notes);
`#framePlay` draws the cursor that far behind `positionNow()` and keeps frames coming until it has
arrived, also paused or held at a gate. A seek, a rewind, the end and a return from browsing reset it;
with `deps.reducedMotion` nothing is kept and the cursor jumps.

**Live MIDI timing (U111).** `PerformanceTiming` compares the time between the first
`accepted` MIDI attacks of consecutive groups with their written gap at the selected speed.
The frame draws the cue, and the session's tick can clear it while playback waits at a gate.
Starting, seeking, and changing speed reset the comparison.

A change of source (a piano connecting or leaving) pauses a started Follow
and drops it (`#syncFollowSource` → `#disposePlay(true)`), so the next Start rebuilds it for the new
source; a piano unplugged while the microphone already follows changes nothing. `ui.follow`,
`ui.pianoConnected` and `ui.micSupported` say which and why. Tests: `PracticeSession.mic.test.ts`.

## Tests

`PracticeSession.test.ts` (reading, scored lifecycle, repeat readiness, Repeat mode and the
cursor repeat button, loop wrap, interruptions, disconnect, continuous timing for both hands,
gate waiting, early grace and the soft early feedback, octave and accidental cues, background
playback, Listen,
Auto sound destination, hints, persistent-label exposure and fades, keyboard guide and
assistance, naming, no per-event UI publication), `guide.test.ts`, `labels.test.ts`,
`selection.test.ts`, `persistence.test.ts`. `npx vitest run src/app/session`.
`PracticeSession.modes.test.ts` covers the modes: every change of mode from idle, playing and paused
(nothing of the old one left), awkward moments, one hand in Listen, what each mode records and saves,
and the piano going away and coming back. `openingMode.test.ts`, `PracticeSession.restore.test.ts`:
how a piece opens.
`PracticeSession.cursor.test.ts` covers starting and resuming from browsed notation, restoring
page following, Repeat/Listen bounds, and seeks while browser sounds load.

## Decisions

See DECISIONS P2–P8 (proposed in the WP10 report): accompaniment allowed with browser sound;
zoom/orientation never interrupt (P5 revised); seeks
ignored while a scored attempt is preparing/ready; another mode interrupts a scored attempt;
leaving the view is a user stop.
