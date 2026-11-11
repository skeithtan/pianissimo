# core/engine — practice engine

Pure, synchronous, framework-free TypeScript. It follows the learner's onset groups, grades
fresh key presses, drives hints, ottava warnings and the scored-attempt lifecycle, and
produces `AttemptRecord`s for history. It never reads clocks, timers or MIDI directly: the
session passes human MIDI events and `now` (the `performance.now()` timebase, the same as
MIDI event times). Spec: "Score following", "Mistake feedback and hints", assistance
paragraphs of "Persistent score labels" and "Keyboard rescue", "Repeating passages",
"Results and timing", transport rules of "Listening and hand practice".

## Public API (`index.ts`)

| Entry point | Purpose |
| --- | --- |
| `buildTimeline(model, {hands, range, multiplier, tempo?})` | Learner onset groups, measures, automatic positions, reference timing, blockers, comparison context. Built once per hands/range/tempo/speed. A note-level `range` (`start` / `end` inside its boundary bars, U21) covers `[start, end)`: groups, boundary reattacks at `start`, timing from `start`, notated duration to `end`, timing issues inside; a boundary bar that leaves out learner onsets is `partial` and its traversals are never complete (H7). Edges on barlines normalize to whole bars (unchanged comparison keys). Each group also carries `tiedPitches` (pitches tied into it: tie-end presses, E16) |
| `transportGates(timeline)` | Gate positions for the transport (gate `i` = group `i`). |
| `groupAtOrAfter(timeline, position)`, `barLabel(model, occ)` | Resume positions; "12 (pass 2)" labels. |
| `new PracticeEngine(timeline, config, now)` | The state machine (see below). |
| `fadeOutOpacity(elapsedMs, durationMs)`, `easeInOut(p)` | Shared eased fade curve (smoothstep): exactly 1 before, exactly 0 at the end. Renderer labels and keyboard-guide hiding use it too. |
| `EARLY_PRESS_GRACE_MS` (120), `matchingRulesFor(graceMs)` | Early-press grace window and the matching-rules id recorded with it. |
| `DEFAULT_RHYTHM_TOLERANCE_MS` (150), `rhythmMatchingRulesFor(toleranceMs)` | Rhythm mode (strict transport) default tolerance and its matching-rules id (`strict-v1-tol-<n>ms`). See "Strict transport (rhythm mode)". |
| `buildAttemptRecord`, `comparisonContextOf` | Record builders (used internally; exported for history tests). Scored records carry per-group outcomes (`groups: GroupOutcome[]`, type re-exported here). |
| `testkit.ts` | Test-only: `buildScore` (compact note lists → valid `ScoreModel`), `MidiScript`, `EngineDriver`, `pedalDetector`. |

### `PracticeEngine`

| Call | Effect |
| --- | --- |
| `input(ev)` | One human MIDI event (echoes already filtered). Consumed once by `seq`. Positive Note On = the only attack; Note Off / velocity-0 = release; CC = pedals (64/66 tracked, hint pedal consumed by `config.hintPedal`, 123 releases a channel). Pending presses past their grace are judged first. |
| `tick(now)` / `nextDeadline()` | Pending-press deadlines, hint expiry (re-arms the auto threshold), finished fades, Ready checks. `nextDeadline` gives the real time of the next change (null when none). |
| `temporaryLabelOpacity(now)` | `Map<PerformedNote.index, 0..1>` of temporary labels (eased; absent = none). Per animation frame; combine with persistent labels by `max`, one label per note. |
| `requestHint(now)`, `dismissHint(now)` | Manual hint request (pedal goes through `input`), explicit dismissal (fade). |
| `setKeyboardVisible(v, now)` | Keyboard guide; showing marks keyboard assistance. |
| `recordPersistentLabelExposure(notes, now)` | Visible persistent labels. Call on every `exposure-reset` event and whenever newly placed labels become visible (read-ahead included). |
| `markPrepared(now)` | Scored: preparation done (score ready, automatic tail finished, output released, transport at the passage start, persistent-label fades finished). |
| `pause` / `resume` | Reading: freeze/unfreeze (progress kept). Scored: `pause` interrupts. |
| `interrupt(reason, now)` | Ends the attempt/traversal: `user-stop`/`user-restart` → abandoned, others → interrupted. `disconnect` forgets physical state. |
| `restart(now, {runningStart?})` | Repeat reset (scored → Preparing) / restart passage (reading → group 0). `runningStart`: see "Per-group outcomes". |
| `seek(group, now)` | Scored: interrupts. Reading: new traversal at `group`. |
| `transportArrived(group, now?)` | Transport reached gate `group` (accompaniment and strict; ignored in free). |
| `startRunning(now)` | Strict transport only: the count-in ended; Ready → Running and the attempt clock starts at `now`. A no-op in any other transport or phase. |
| `reconfigure({reason, timeline?, mode?, transport?, rhythm?, startGroup?, runningStart?}, now)` | Hands/range/tempo/speed/mode change. Pass `runningStart: true` at a lead-in hand-over (the transport keeps playing into the loop). |
| `updateSettings(patch, now)` | Hint settings, label snapshot (a changed mode/rule interrupts an active scored attempt), hint pedal, pass tolerance, `transportEta`, `rhythm` (a changed tolerance interrupts an active strict attempt). |
| `state` | Readonly snapshot, reused until `version` changes. |
| `drainEvents()` | Change events since the last drain (see `EngineEvent` in `types.ts`). |

### Session wiring

```
MIDI adapter ─(human events)─► engine.input ─► drainEvents ─► rAF visuals / transport / history
transport.onGateReached(i) ──► engine.transportArrived(i)
'input-complete' {group} ────► transport.releaseGate(group)   (not in strict, see below)
'exposure-reset' ────────────► engine.recordPersistentLabelExposure(visible labels)
'attempt-ended' {record} ────► history.ingestAttempt + storage batch
'abandon' {event} ───────────► history.ingestAbandon
restart: engine.restart() → transport.seek(start) → … → engine.markPrepared()
```

The transport is created with `transportGates(timeline)` in accompaniment and strict modes, and
the engine gets `config.transportEta = (group, atTime) => ms until that gate` (0 when
reached/holding/passed, null when blocked behind an unreleased gate); pass the transport's
own arrival time as `transportArrived(i, at)`. A gate released before the transport reaches
it (input completed within the grace) makes the transport fast-forward to it, so
`onGateReached(i)` → `transportArrived(i)` runs synchronously inside `releaseGate(i)`, i.e.
while the session is still draining; the drain must tolerate that re-entry. Call `engine.restart()`/`seek()` before
repositioning the transport so arrivals belong to the new attempt. Schedule `tick` at
`nextDeadline()` so pending presses are judged on time.

## Early-press grace (user decision)

`EARLY_PRESS_GRACE_MS = 120` real milliseconds (80 until 31 October 2026), not scaled by the tempo multiplier
(`config.earlyGraceMs` overrides it; records then name `match-v2-early-grace-<n>ms`).

1. **Accompaniment, current group i.** A fresh press of a missing pitch of group i is
   accepted only if gate i is already reached/holding, or `transportEta(i, pressTime) < 120`.
   Otherwise it is a wrong attack with reason `'early'`. Without `transportEta` (and in free
   mode) there is no early check.
2. **Next group, both modes.** A press of a pitch not required by group i but required by
   group i+1 (never further) is *pending* until `pressTime + 120`. If group i completes and
   advances in time (accompaniment: its gate reached too), the press is applied to i+1 with
   its original timestamp — in accompaniment only when gate i+1 is within 120 ms of the
   press (ETA, or the actual arrival when the ETA is unknown), else `'early'`. A pending press
   still waiting when the window ends while group i is current becomes `'ahead'`, with its
   original timestamp. Several pending presses (an early next chord) are allowed.
3. **Replay first.** A press of a pitch already accepted in group i stays a replay.
4. **Reasons.** `wrong` events and `state.lastWrongReason` carry `'pitch' | 'ahead' | 'early'`
   (`wrong` events also `'tie-end'`, which is not a wrong attack: see "Per-group outcomes").
   `'early'` counts as a wrong attack (totals, bar traversal, first-pass, red wash) but not
   toward the automatic hint threshold, and triggers neither the ottava warning nor the
   wrong-key marking. `'ahead'` behaves like a pitch error.
5. **Clock and keys.** The first fresh press in Ready starts the clock at its own time even
   when pending or too early; physical key state updates immediately.
6. Pending presses are dropped without errors on interrupt, seek, restart, reconfigure and
   an ordinary pause. A group completed by pending presses records its completion at the
   later of the press and the previous group's completion (monotonic onsets).

## Per-group outcomes (teacher corrections, E15–E16)

Scored records carry `groups: GroupOutcome[]`, one per reached group, ascending (completed
groups and, when the attempt ended early, the current one); reading records carry none.

| Field | Rule |
| --- | --- |
| `wrongAttacks`, `earlyAttacks` | Wrong attacks attributed to the group; of them, right pitches too early (E12). |
| `lateMs` | Whole ms from the gate's arrival (`transportArrived`) to the group's input completion; 0 when completed at or before arrival, not completed, or in free mode. **The group whose press started the clock is never late** (the transport waits at the first gate for that press, P9), unless the attempt began with `runningStart: true` (a lead-in handing over while the transport runs into the loop), where it is measured like any other group. |
| `wrongPitches` | MIDI pitches of the group's wrong attacks that were not too early, in order, repeats included. |
| `spreadMs` | Whole ms between the first and last accepted attack (engine press times; replays ignored); 0 for a one-pitch group or an incomplete one. |
| `tieEndPresses` | Presses of a pitch in the group's `tiedPitches` while it is current, or within the early grace before it (pending like a next-group press; expiring before the group comes it is a `'pitch'` error of the current group). A pending next-group press whose pitch is also tied into the current group expires as a tie-end press instead of `'ahead'`. A tie-end press emits `wrong` with reason `'tie-end'` (feedback end unchanged) and is **not** a wrong attack: no totals, first-pass, bar traversal, red wash, local marker, held-wrong marking, hint count or ottava warning, and `lastWrongReason` is kept. Give it gentle feedback only. |

`tiedPitches` (timeline): learner tie continuations go to the first group at or after their
onset, unless that group attacks the pitch itself; a tie end after the last group belongs to
none. A tie chain attacked **before** a loop start is not required inside the loop (no boundary
reattack, no group of its own): its pitch is a tied pitch of the first group (user, 31 October
2026). Held, untied notes crossing the loop start keep the boundary reattack.

## Strict transport (rhythm mode, DECISIONS P13)

`transport: 'strict'` (`TransportKind`, the contract's name; `TransportMode` is a deprecated
alias) is scored only and needs `rhythm: { toleranceMs }` (config, `reconfigure` or a settings
patch; RangeError otherwise, and for strict with reading mode). The music never waits: every
onset group is judged against its scheduled time, the transport's arrival at its gate.

1. **Clock.** Presses in Ready only update physical key state (no clock, no judging, no wrong
   attack). The session calls `startRunning(now)` at the end of its count-in: Ready → Running,
   `clockStartedAt = now`, event `clock-started`. The first group is judged like every other
   (the never-late rule of E15 is gated-only, so its `lateMs` is measured too).
2. **Current group i.** A press of a missing pitch before gate i arrives and more than
   `toleranceMs` before it (by `transportEta`; unknown counts as too far) is a `'early'` wrong
   attack (E12 semantics: soft feedback, counts, not toward auto hints). Within the tolerance
   before arrival, or any time after arrival while the group is open, it is accepted.
3. **Offsets.** When the group completes, `offsetMs` = completion − scheduled arrival in whole
   ms (before arrival the scheduled time is completion + ETA, so it is negative). `lateMs` stays
   ≥ 0 as before. `state.lastOffsetMs` holds the latest one for live feedback. A completed group
   advances at once: strict never sets `waitingForTransport`.
4. **Closing by the clock.** Group i closes at `arrival(i) + toleranceMs` if still incomplete:
   event `missed { group, notes, time }`, outcome `missed: true`, `missedGroups` + 1, a group with
   errors of its bar (whose traversal can still be `complete`: missed groups count as traversed),
   hint retired, local marker cleared, then group i + 1 is current (or the attempt completes).
   A press exactly at the close time is still on time; a `tick` at that time closes.
   `nextDeadline()` includes the close once gate i has arrived. An arrival at a later gate than
   the current group (the clock is ahead) closes the groups whose gates it skipped at once, in
   order; a group whose own gate arrived earlier keeps its own close. Arrivals at gates already
   reached or at groups already left change nothing.
5. **Late slip.** A press of a pitch of the group that just closed as missed (and not a pitch of
   the current group), before the transport reaches the current group's gate or within
   `toleranceMs` after the close (whichever is later), emits `wrong` with
   reason `'late'`: like `'tie-end'` it is not a wrong attack and is not recorded (no totals,
   bar counts, red wash, hint count, marker, `lastWrongReason`). O(1): only the last closed
   group is remembered.
6. **Next group.** Presses for group i + 1 while i is current are pending as in E12, with
   `toleranceMs` as the window; when i + 1 becomes current they are accepted if its gate is (or
   was) within the tolerance of the press, else `'early'`; still waiting at the window's end they
   are `'ahead'`. A close and a pending deadline at the same time: the close is processed first.
   A press for a later group (i + 2 onward, nearest first, at most 16 ahead) whose scheduled time
   is within the tolerance of the press (gate reached, or ETA ≤ `toleranceMs`) is pending for that
   group the same way, so one slip on a fast run costs one group. Further ahead it stays `'pitch'`.
7. **Completion and records.** The attempt completes when the last group closes (complete or
   missed); `completionTimeSec` runs from the clock start to the last group's completion or
   close. Records carry `context.transport = 'strict'`, `matchingRules = strict-v1-tol-<n>ms`,
   `rhythm`, `missedGroups` and per-group `offsetMs` / `missed`. `passed` = completed ∧ no wrong
   attack ∧ no assistance ∧ no missed group ∧ every completed group within ±`toleranceMs`; the
   total-time tolerance does not apply. Hints, labels, keyboard assistance and ottava warnings
   are unchanged. Pause, seek, restart, reconfigure and interruptions behave as for any scored
   attempt (`restart` → Preparing → Ready; the session calls `startRunning` after its next
   count-in).

Session wiring (strict):

```
count-in ends at t0 ─────────► engine.startRunning(t0); the transport runs from t0
transport.onGateReached(i) ──► transport.releaseGate(i) at once, then engine.transportArrived(i, at)
'input-complete' {group} ────► (ignored: releasing a gate early would move the music)
'missed' {group, notes} ─────► gentle "missed" feedback; nothing to release
schedule tick at nextDeadline() (closes and pending windows)
```

## State diagram

```
 scored                                                       reading
 ──────                                                       ───────
 new / restart ─► PREPARING ──(prepared ∧ no keys ∧            new / restart / seek
                     │         fades done; pedals never block)    │
                     │                ▼                           ▼
                     │             READY ──(fresh Note On,     RUNNING ◄──pause/resume──► PAUSED
                     │               │      even wrong:            │        (progress kept,
                     │               │      clock starts)          │         timers frozen)
                     │               ▼                             │
                     │           RUNNING ─(final group: input      │
                     │               │     complete ∧ gate reached)│ (last group)
                     │               ▼                             ▼
                     │          COMPLETED ── record ──► restart   COMPLETED
                     ▼               ▲                             │
 interrupt/pause/seek/settings ─► INTERRUPTED ──restart──► …    interrupt ─► INTERRUPTED ─resume─► RUNNING
```

Per group: `current` → (each fresh correct pitch accepted, kept after release) → `input
complete` (exactly once; hint retired + fading, ottava warning and local marker cleared) →
free and strict: advance at once; accompaniment: advance when `transportArrived(group)` has also
happened (`waitingForTransport` meanwhile).

## Design notes

- **Separate states.** Accepted pitches (per group), physical keys, sustain/sostenuto values
  and wrong held keys are tracked separately; a held key or sustained sound never attacks.
- **O(small) input path.** A Note On does an `indexOf` in one group's pitches plus set/map
  updates and pushes a few events. No allocation-heavy work; the snapshot is rebuilt lazily.
- **Active clock.** Hint lifetimes and all temporary-label fades run on real time minus
  ordinary-reading pauses, so pause freezes them and tempo never affects them.
- **Fades.** A timed hint fades over its final `fadeMs` (clamped to the lifetime) and is
  invisible at expiry; completion/dismissal fades from the current opacity over `fadeMs`,
  attached to the original notes. A manual request removes fades of the same notes (opacity 1).
- **Records.** `AttemptLog` accumulates per attempt/traversal; bars close when the cursor
  leaves them (or at the end/interruption). Traversals: complete = every required group of
  the bar completed in this traversal.

## Spec coverage

| Item | Status |
| --- | --- |
| Timeline: learner groups, shared pitch once, ties excluded, rests skipped, loop-start boundary reattacks of held notes (flagged, synthetic; ties attacked before the loop are not reattacked), tied pitches, expected sustain, roll offsets, expected span, notated duration, timing-unscored reasons, blockers (no onsets, tempo missing, unsupported, hands unconfirmed), automatic positions + unisons | ✅ |
| Matching: every row of the situation table; consumed once; held keys/sustain never satisfy; completion exactly once | ✅ |
| Early-press grace: accompaniment gate window, next-group pending window, wrong reasons | ✅ |
| Modes: reading (pause keeps progress) vs scored (pause interrupts); free vs accompaniment gates | ✅ |
| Scored lifecycle, Ready blockers, first-press clock, repeat reset | ✅ |
| Wrong feedback (monotonic `wrongFeedbackUntil`), local marker, held wrong keys | ✅ |
| Ottava warning: applicable spans at the expected position on selected parts, first error, held to completion, cleared on seek/restart/interrupt | ✅ (engine side; drawing is the renderer's) |
| Hints: threshold (incl. off), re-arm after expiry, manual restart, active-time lifetime, until-correct, eased fades, pause freeze, keyboard assistance, hint pedal | ✅ |
| Persistent-label assistance per note/group/bar, fresh per attempt, distinct from requests | ✅ (exposure detection is the renderer's) |
| AttemptRecord / MeasureTraversal / AbandonEvent | ✅ |
| Persistent-label fades before Ready | 🟡 session delays `markPrepared` (renderer owns those fades) |
| Resume position persistence | 🟡 `state.position` / `groupIndex` provided; storage is the session's |

## Decisions and interpretations

1. **Exposure scope.** Only learner notes (required notes and tie continuations of required
   attacks) not yet completed in this attempt count as label assistance; labels on automatic
   notes, behind the cursor or outside the passage do not.
2. **Unstarted attempts** (no fresh press) end with `attempt-discarded`, not a record: they
   carry no diagnostics and would otherwise add an empty attempt on every Stop after Repeat.
3. **Reading traversals** produce `kind: 'reading'` records (untimed, never passed) when
   they end: end of piece, seek, interruption, restart or reconfigure. A tempo/speed change
   while reading splits the traversal but keeps the current target and its accepted pitches.
4. **Timing issues** make the attack span unscored only between the first and last required
   attack: a fermata on the final chord (final sustain) or before the first attack does not;
   verbal tempo/rubato before the final attack does.
5. **Missing tempo** blocks scored practice (`tempo-missing`); ordinary reading still works.
6. **One-hand ottava scope:** spans active at the position whose staff holds the group's
   notes or that displace any learner-hand note. Both hands: every active span.
7. **Accompaniment** (replaces the earlier rule; see "Early-press grace"): correct presses
   count only within 120 ms of their gate; next-group presses get the same window; anything
   else while waiting is a wrong attack. The attempt completes when the final gate is also
   reached; completion time ends at the final attack. A pending press resolved after its
   group became current but still too far from its gate is `'early'` (right pitch, too soon)
   rather than `'ahead'`.
8. **Auto-hint counter** counts errors only while no hint is visible; it resets on show,
   expiry and advancement.
9. **Hint pedal** is consumed inside `input` via an injected detector (structurally
   compatible with core/midi's `HintPedalTrigger`); its controller is never tracked as
   sustain/sostenuto and never blocks Ready. The 'keys' action shows (does not toggle) the guide.
10. **Disconnect** forgets physical key/pedal state (releases are lost while absent).
11. **Label mode/rule change** during an active scored attempt (Preparing/Ready/Running)
    interrupts it with `setting-change`.
12. **Keyboard assistance** marks every bar whose group is current while the guide is
    visible, and the next attempt if it is still visible at the reset.
13. **Onset timestamps** record when each group's input completed (seconds from the first press).
14. **Fade curve:** smoothstep; outgoing fades continue from the current opacity.
15. **Held pedals never block Ready** (user, 31 October 2026): only held keys, preparation and
    label fades do. `ReadyBlocker` keeps `'pedals-held'` for compatibility; it is never emitted.
16. **Per-group outcomes.** See "Per-group outcomes" above (E15 revised, E16 tie-end presses;
    E17 pedal checking was removed). Reading traversals carry no `groups`.

## Play-through follower (`follow.ts`, DECISIONS P12)

`PlayFollower` follows the learner over the same `Timeline` in Play-through mode: a
performance aid that is never blocked by wrong notes and grades or records nothing. Pure and
synchronous like the engine (time injected, input consumed once by `seq`, lazy snapshot,
drained events); no hints, records, pedals (except CC 123) or lifecycle.

| Entry point | Effect |
| --- | --- |
| `new PlayFollower(timeline, {wrongFeedbackMs?, startGroup?}, now)` | Starts at `startGroup` (default 0). An empty timeline is finished from the start. |
| `input(ev)` | Positive Note On = the only attack; Note Off / velocity 0 release; CC 123 releases the channel's keys; everything else ignored. While paused or finished only held keys change. |
| `tick(now)` / `nextDeadline()` | Patience release of the current group; `nextDeadline` is null when there is no deadline (or paused). |
| `transportArrived(group, now)` | Current group: marks arrival (first arrival kept). Earlier group: ignored. Later group: it becomes current (accepted cleared, `advanced`, nothing released). |
| `pause(now)` / `resume(now)` | Freezes the patience clock and judging. |
| `seek(group, now)` | New current group: accepted, arrival, first press and error cleared; held keys and pause kept; no events. |
| `reconfigure(timeline, now, startGroup?)` | Speed/hands change. Default group: first at or after the old position; when the position is unchanged the arrival, first press and still-required accepted pitches are kept. |
| `resetPhysical(now)` | Disconnect: forget held keys. |
| `state` / `drainEvents()` | `FollowerState` snapshot; `accepted`, `wrong`, `release {group, reason: 'complete' \| 'skipped' \| 'patience'}`, `advanced {from, to}`, `key`, `finished`. |
| `patienceMs(timeline, i)` | Patience of group `i` in real ms. |

Rules, for a fresh press at current group `i` (any press, right or wrong, also starts the
group's patience if none has):

1. A missing pitch of `i` is accepted (also before the transport arrives); when the group is
   complete: `release {i, 'complete'}`, and `i + 1` is current at once (**advance on release**,
   so presses for `i + 1` before the transport gets there are accepted), or `finished`.
   An accepted pitch again is a silent replay; a pitch in `i`'s `tiedPitches` is silent.
2. **Moved on**: a pitch of group `j` in `(i, i + LOOKAHEAD_GROUPS]` (`LOOKAHEAD_GROUPS = 2`,
   nearest first) emits `release {i..j-1, 'skipped'}` in order, `advanced {i, j}`, then accepts
   the pitch in `j` (which may complete it). The moving press is `j`'s first press.
3. A pitch of the previous `LOOKBEHIND_GROUPS = 1` group is a silent late correction. It is
   checked before the lookahead, so a pitch of both the previous and a next group is a late
   repeat (no move-on); a genuine skip is caught one note later by the next press's lookahead.
4. Anything else is `wrong`: gentle feedback until `time + wrongFeedbackMs` (default
   `FOLLOW_WRONG_FEEDBACK_MS = 300`), `groupHasError`, held-wrong key; never blocks.
5. **Patience**: deadline `max(arrivedAt, firstPressSinceCurrent) + patienceMs(timeline, i)`,
   only when both exist; then `release {i, 'patience'}`. A learner who stops playing (no press
   since the group became current) is waited for indefinitely.
   `patienceMs` = time at the current speed from the group's onset to the next group's onset,
   clamped to `[PATIENCE_MIN_MS = 300, PATIENCE_MAX_MS = 2000]`; the last group (or no tempo)
   `PATIENCE_LAST_MS = 1000`.
6. **Pause**: `nextDeadline()` is null while paused and presses are not judged. On `resume`
   the anchors set before the pause shift by the paused duration and anchors set during the
   pause (an arrival) start at the resume, so paused time never counts.
7. Keys held before a group became current never satisfy it (only fresh presses do).

Session wiring: `transport.onGateReached(i)` → `transportArrived(i, at)`; each `release {g}` →
`transport.releaseGate(g)` in order. A release before the transport reached the gate makes it
fast-forward, so `transportArrived` runs re-entrantly inside the drain loop; arrivals at gates
the follower already left are ignored, and new events land in the next drain (drain until
empty). Schedule `tick` at `nextDeadline()` after every drain.
