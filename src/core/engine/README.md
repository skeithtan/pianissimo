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
| `buildTimeline(model, {hands, range, multiplier, tempo?})` | Learner onset groups, measures, automatic positions, reference timing, blockers, comparison context. Built once per hands/range/tempo/speed. A note-level `range` (`start` / `end` inside its boundary bars, U21) covers `[start, end)`: groups, boundary reattacks at `start`, timing from `start`, notated duration to `end`, timing issues inside; a boundary bar that leaves out learner onsets is `partial` and its traversals are never complete (H7). Edges on barlines normalize to whole bars (unchanged comparison keys). Each group also carries `tiedPitches` (pitches tied into it: tie-end presses, E16) and `pedalDown` (sustain the score wants at its onset; null without sustain marks, E17). |
| `transportGates(timeline)` | Gate positions for the transport (gate `i` = group `i`). |
| `groupAtOrAfter(timeline, position)`, `barLabel(model, occ)` | Resume positions; "12 (pass 2)" labels. |
| `new PracticeEngine(timeline, config, now)` | The state machine (see below). |
| `fadeOutOpacity(elapsedMs, durationMs)`, `easeInOut(p)` | Shared eased fade curve (smoothstep): exactly 1 before, exactly 0 at the end. Renderer labels and keyboard-guide hiding use it too. |
| `EARLY_PRESS_GRACE_MS` (120), `matchingRulesFor(graceMs)` | Early-press grace window and the matching-rules id recorded with it. |
| `PEDAL_GRACE_MS` (150) | A sustain change toward the score this soon after a group's completion still counts for it. |
| `buildAttemptRecord`, `comparisonContextOf` | Record builders (used internally; exported for history tests). Scored records carry per-group outcomes (`groups: GroupOutcome[]`, type re-exported here). |
| `testkit.ts` | Test-only: `buildScore` (compact note lists → valid `ScoreModel`), `MidiScript`, `EngineDriver`, `pedalDetector`. |

### `PracticeEngine`

| Call | Effect |
| --- | --- |
| `input(ev)` | One human MIDI event (echoes already filtered). Consumed once by `seq`. Positive Note On = the only attack; Note Off / velocity-0 = release; CC = pedals (64/66 tracked, hint pedal consumed by `config.hintPedal`, 123 releases a channel). Pending presses past their grace are judged first. |
| `tick(now)` / `nextDeadline()` | Pending-press deadlines, hint expiry (re-arms the auto threshold), finished fades, Ready checks. `nextDeadline` gives the real time of the next change (null when none). |
| `temporaryLabelOpacity(now)` | `Map<PerformedNote.index, 0..1>` of temporary labels (eased; absent = none). Per animation frame; combine with persistent labels by `max`, one label per note. |
| `requestHint(now)`, `dismissHint(now)` | Manual hint (button; pedal goes through `input`), explicit dismissal (fade). |
| `setKeyboardVisible(v, now)` | Keyboard guide; showing marks keyboard assistance. |
| `recordPersistentLabelExposure(notes, now)` | Visible persistent labels. Call on every `exposure-reset` event and whenever newly placed labels become visible (read-ahead included). |
| `markPrepared(now)` | Scored: preparation done (score ready, automatic tail finished, output released, transport at the passage start, persistent-label fades finished). |
| `pause` / `resume` | Reading: freeze/unfreeze (progress kept). Scored: `pause` interrupts. |
| `interrupt(reason, now)` | Ends the attempt/traversal: `user-stop`/`user-restart` → abandoned, others → interrupted. `disconnect` forgets physical state. |
| `restart(now, {runningStart?})` | Repeat reset (scored → Preparing) / restart passage (reading → group 0). `runningStart`: see "Per-group outcomes". |
| `seek(group, now)` | Scored: interrupts. Reading: new traversal at `group`. |
| `transportArrived(group, now?)` | Transport reached gate `group` (accompaniment only). |
| `reconfigure({reason, timeline?, mode?, transport?, startGroup?, runningStart?}, now)` | Hands/range/tempo/speed/mode change. Pass `runningStart: true` at a lead-in hand-over (the transport keeps playing into the loop). |
| `updateSettings(patch, now)` | Hint settings, label snapshot (a changed mode/rule interrupts an active scored attempt), hint pedal, pass tolerance, `checkPedal`. |
| `state` | Readonly snapshot, reused until `version` changes. |
| `drainEvents()` | Change events since the last drain (see `EngineEvent` in `types.ts`). |

### Session wiring

```
MIDI adapter ─(human events)─► engine.input ─► drainEvents ─► rAF visuals / transport / history
transport.onGateReached(i) ──► engine.transportArrived(i)
'input-complete' {group} ────► transport.releaseGate(group)
'exposure-reset' ────────────► engine.recordPersistentLabelExposure(visible labels)
'attempt-ended' {record} ────► history.ingestAttempt + storage batch
'abandon' {event} ───────────► history.ingestAbandon
restart: engine.restart() → transport.seek(start) → … → engine.markPrepared()
```

The transport is created with `transportGates(timeline)` in accompaniment mode only, and
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

## Per-group outcomes (teacher corrections, E15–E17)

Scored records carry `groups: GroupOutcome[]`, one per reached group, ascending (completed
groups and, when the attempt ended early, the current one); reading records carry none.

| Field | Rule |
| --- | --- |
| `wrongAttacks`, `earlyAttacks` | Wrong attacks attributed to the group; of them, right pitches too early (E12). |
| `lateMs` | Whole ms from the gate's arrival (`transportArrived`) to the group's input completion; 0 when completed at or before arrival, not completed, or in free mode. **The group whose press started the clock is never late** (the transport waits at the first gate for that press, P9), unless the attempt began with `runningStart: true` (a lead-in handing over while the transport runs into the loop), where it is measured like any other group. |
| `wrongPitches` | MIDI pitches of the group's wrong attacks that were not too early, in order, repeats included. |
| `spreadMs` | Whole ms between the first and last accepted attack (engine press times; replays ignored); 0 for a one-pitch group or an incomplete one. |
| `tieEndPresses` | Presses of a pitch in the group's `tiedPitches` while it is current, or within the early grace before it (pending like a next-group press; expiring before the group comes it is a `'pitch'` error of the current group). A pending next-group press whose pitch is also tied into the current group expires as a tie-end press instead of `'ahead'`. A tie-end press emits `wrong` with reason `'tie-end'` (feedback end unchanged) and is **not** a wrong attack: no totals, first-pass, bar traversal, red wash, local marker, held-wrong marking, hint count or ottava warning, and `lastWrongReason` is kept. Give it gentle feedback only. |
| `pedal` | Only when the group has `pedalDown !== null` and `checkPedal` is on (default; turn it off while the app plays the score's pedals): physical sustain (CC 64 ≥ the down threshold) at completion vs the score: `'ok'`, `'missing'` (score down, pedal up) or `'extra'` (score up, pedal down). A mismatch becomes `'ok'` when the pedal reaches the score's state within `PEDAL_GRACE_MS` (150) after completion (each group keeps its own grace, even when the next group completes inside it); the final group's record is built at completion, so only the state then counts for it. `'none'` otherwise (incomplete groups included). |

`tiedPitches` (timeline): learner tie continuations go to the first group at or after their
onset, unless that group attacks the pitch itself; a tie end after the last group belongs to
none. A tie chain attacked **before** a loop start is not required inside the loop (no boundary
reattack, no group of its own): its pitch is a tied pitch of the first group (user, 31 October
2026). Held, untied notes crossing the loop start keep the boundary reattack.
`pedalDown` (timeline): the sustain state after every sustain mark at or before the onset, in
score order (`start`/`change` down, `stop` up, `continue` keeps; marks before the passage shape
its first groups); sostenuto and soft marks never decide it.

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
free: advance at once; accompaniment: advance when `transportArrived(group)` has also
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
16. **Per-group outcomes.** See "Per-group outcomes" above (E15 revised, E16 tie-end presses,
    E17 pedal checking). Reading traversals carry no `groups`.
