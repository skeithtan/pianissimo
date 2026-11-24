# core/audio — audio score follower

Tells from microphone samples which onset group of a score the player has reached, so
Play-through (DECISIONS P12) can follow an acoustic piano without MIDI. Pure, synchronous,
framework-free TypeScript with no DOM, no Web Audio and no dependency; wired into play-through by
P15, redesigned by P16.

Position only: from a microphone the follower cannot tell a wrong note from a right one, and
Play-through does not need it to. Both hands only: the microphone must never hear the app's own
playback (the metronome included).

**It follows attacks, not time.** The position moves only when something is struck that fits
one of the onset groups near it. A chord that rings on, a held pedal, room noise or silence
change nothing, however long they last, so a learner who stops to find the next notes is waited
for. No tempo is involved: the player may take any time, and Speed means nothing to it. (The
first version, P14, warped time against a tempo-based reference and kept advancing through
stops. See "Measured".)

## Pipeline

```
samples ─► SemitoneAnalyzer ─► OnsetMatcher ─► group heard last ─► position
            (features.ts)       (matcher.ts)                        (index.ts)
                                    ▲
              attackTemplates(attackGroups(model), sampleRate)   (templates.ts)
```

- **Semitone energies** (`features.ts`): 4096-sample frames (85 ms at 48 kHz, 93 ms at 44.1)
  every 10 ms, an in-repo radix-2 FFT, power summed into one bin per piano semitone (MIDI
  21–108), scaled so a full-scale sine reads 1. The frame is long because pitch decides
  everything here. Measured on real piano notes (cosine of an attack's log-compressed rise with
  a template): with the first version's 46 ms frames and strong compression a note resembled
  its semitone neighbor at 0.48 and itself at 0.74; with these frames and the gentler
  compression used now, 0.29 and 0.78. The window is skewed (sin² up over three quarters of the
  frame, cos² down over the last quarter), so an attack weighs in sooner than under a Hann
  window (decisions come 5 to 15 ms sooner).
- **What is expected** (`templates.ts`): `attackGroups(model)` lists the positions where notes
  are struck with their distinct pitches (tie continuations, grace and cue notes left out: the
  practice timeline's groups for both hands). A group's `AttackTemplate` is the sum of its
  pitches' semitone energies: 16 partials at h^−2.5 power (`ROLL_OFF`; a real piano through a
  phone gives its third and higher partials 15–30 dB under the fundamental, P21), spread over FFT
  bins by the window's own response (`windowLobe`) and binned exactly as live frames are.
- **Matching** (`matcher.ts`, `OnsetMatcher`, one `step` per frame):
  1. *Rise.* Each semitone has a baseline that falls with the sound (60 dB a second at most:
     the dips of beating partials are not followed, so their return is no attack) and rises
     toward it by a fifth per frame. Energies are log-compressed against a level reference: the
     running peak (20 dB a second decay), never less than 20 dB over the noise floor, which is
     read across the spectrum (the quietest tenth of the semitones from G3 up) so it is known
     even while notes sound. When the norm of the excess over the baselines passes 1.2 an
     **event** opens; it ends when the rise has fallen back or after 100 ms. Only semitones from
     G3 up count, here and for the evidence (`lowest`): below it a microphone on or near the
     piano hears the thump of every key and hammer, often louder than soft notes (P21); lower
     notes are recognized by their partials.
  2. *Evidence.* The event's observed rise is the energy of each semitone in the frame that
     decides it over the energies just before it (not the loudest during the event: the thump
     is over by then, the note is not). A group's expected rise is what its template would add to those
     same energies, so notes already ringing are discounted, at the best of four loudness
     scales. Their cosine is the group's evidence. The same cosine against a flat spectrum
     recognizes a broadband burst (a thump, a click): no group gets evidence above it.
  3. *Position.* A score per position is updated at each event as in a Viterbi step: the event
     is unexplained (free: nothing moves), or it is the attack of group `c` reached from the
     group before it, from up to four groups earlier (skipped or unheard notes, 0.1 of cosine
     each) or from itself (struck again, 0.1). Positions up to 24 groups behind and 32 ahead of
     the best one (two more ahead for every event since the position last moved, up to 128: a
     follower that missed a stretch finds the player again) are kept within the worth of two or three clear events of it, so a run of
     attacks that fits elsewhere (the player skipped a line, or went back to repeat a bar)
     takes over after a few of them, never after one. While one of the next groups is clearly
     it (cosine ≥ 0.65, a margin over every other outcome) the event is decided before it ends,
     but never sooner than 40 ms after it rose (`minAge`: the thump of the key has mostly faded
     by then). A place beyond the next five groups must lead by more than one behind
     (`jumpAhead` 10 against `jump` 7): play-through cannot take a jump ahead back.
  4. *Chords that arrive in parts* (rolled, or one hand late). For half a second after its
     latest notes the group heard last is open: an event that raises new semitones and makes
     everything struck since the group began fit it clearly better is more of it, at no price.
     An event nothing explains is kept for a moment and read together with the next one.
  5. *Patience* (P36). An event that nothing explains when it ends is listened to for 80 ms more
     (`patience`): in each frame the next five groups are tried again against the sound before
     the event, what each gains over `neutral` is summed (never under zero), and the first whose
     sum passes 0.05 explains it. The thump fades in that time and the note does not. A new
     attack ends the wait. Only within 0.6 s of the last explained attack (`patienceWithin`):
     in a hesitation the stray attacks of a player looking for the notes stay unexplained.
- **Follower** (`index.ts`): `createAudioFollower(model, options?)` →
  `push(samples, sampleRate, time)` returning `{ group, position, confidence, time, frames,
  moved }` (the group heard last, its position in float whole notes, the cosine of the attack
  that moved it), `reset(position?)` (expect the first group at or after it; the sound heard so
  far stays known, so a ringing chord is no attack) and `listen()` (after a gap in the stream:
  forget the sound, keep the position). The first 0.2 s after the first samples or a `listen`
  only fill the frame and measure the level.

| Entry point | Purpose |
| --- | --- |
| `createAudioFollower(model, options?)` | The follower. Builds the templates lazily for the first sample rate seen; a new rate starts listening afresh at the position. |
| `groupReached(timeline, position)` (`groups.ts`) | `Timeline` group index at or before a float position (−1 before the first); the only part the session bundles. |
| `SemitoneAnalyzer`, `Fft`, `analysisWindow`, `windowLobe`, `frameSize`, `hopSize` | The front end. |
| `attackGroups`, `attackTemplates`, `pitchTemplate` | What is expected. |
| `OnsetMatcher` (`step`, `group`, `confidence`, `seek`, `listen`), `MatcherOptions` | The matcher and its tunables; `trace` reports every decided event (cosine per group tried, flatness, explained or not). |
| `evaluate.ts`, `testkit.ts` | Test support: `perform` (a perturbed performance: tempo factor, ±15 ms jitter, wrong and missing notes, stops with keys held or released, rubato, pedaling as marked or notes ringing longer), `renderNotes` (an additive synthesizer that differs from the templates on purpose: inharmonic partials at 0.6^h with per-partial decay, random velocities, noise), `evaluate` / `evaluateAudio` (when each onset is reached; `ahead` = reached more than 150 ms before it was played). |

## Measured

### Real recording (P21)

The user's own acoustic piano, recorded with a phone while playing the 61-bar reference piece
start to finish with many mistakes and long pauses (`tests/fixtures/private/audio/`, 6:12, mono
48 kHz, converted from AAC). The truth (`reference-piece.onsets.tsv`) was built offline by a
global alignment that allows any pause, skips and going back, and validated on independent
high-resolution spectra (the aligned group's own fundamental stands out by 6 dB at 75.5 % of the
aligned attacks, 20 % for an unrelated nearby group at the same instant); 626 of the 752 onset
groups are listed (12 more were dropped in the second pass: listed under 60 ms after the onset
before them, implausible for this player). `recording.test.ts` replays the WAV through the app's
chain: 512-sample blocks, an estimate whenever the group heard last changes, the session's rule
(confidence ≥ 0.5, never behind the current group) and the play-through cursor (`PlayFollower`)
over the both-hands timeline. Lag = when the cursor released an onset's group minus the onset's
first attack. Distance = every 100 ms, the bar of the group the cursor released last minus the
bar of the onset the player first played last (what a learner watching the cursor sees).

| On the recording, through the session | P16 follower | P21 first pass | P21 second pass | Now (P36) |
| --- | --- | --- | --- | --- |
| Cursor reaches the last group | never (stops at bar 3.6, 3:10) | 0.16 s after its attack | 0.17 s after | 0.17 s after |
| On time (−150…+150 ms) | 0.2 % | 53.4 % | 53.5 % | 61.5 % |
| Within −150…+500 ms | 0.2 % | 65.8 % | 67.7 % | 75.1 % |
| More than a second late | — | — | 18.5 % | 13.3 % |
| Ahead of the player (earlier than −150 ms) | 0 % | 4.8 % | 4.2 % | 4.3 % |
| Worst lag / most ahead | never reached | 13.2 s / 8.1 s | 14.7 s / 8.1 s | 14.7 s / 9.2 s |
| Time within a quarter bar of the player | — | 81.5 % | 83.7 % | 86.0 % |
| Time within one bar | — | 98.1 % | 99.2 % | 99.2 % |
| Most behind / most ahead (bars) | — | 1.38 / 1.13 | 1.38 / 1.25 | 1.10 / 1.06 |
| Time more than a bar off | — | 6.8 s | 2.9 s | 2.9 s |

(The first-pass column is measured against the same, second-pass truth.) Averaged over the
recording as is, shifted by 237 samples, halved in level and with noise added: a quarter bar
81.9 % → 84.0 % of the time, more than a bar off 10.6 s → 2.1 s, ahead 5.2 % → 3.3 %.

P36 (patience): of the 626 listed onsets, 150 opened an event that nothing explained when it
ended (its group's cosine had a median of 0.42) and only 39 opened none; listening on recovers
about a third of the former (402 attacks taken for their own group, 358 before). Averaged over
the recording as is, shifted by 237 samples, halved in level and with white noise at −59 dBFS
added: on time 53.8 % → 61.9 %, a quarter bar 84.1 % → 86.4 % of the time, more than a bar off
2.0 s → 1.7 s, ahead 3.6 % → 4.1 %. Without the flow limit the patience gave the same share on
time but took stray attacks in hesitations for the next groups (ahead 6.9 %, more than a bar off
4.4 s). Tried and left out: a lower threshold for opening events, fixed or falling with the time
since the last attack (up to 6 points more on time, but ahead 7–9 % and up to 15 s early), and
deciding every event later (worse throughout: the next attack arrives meanwhile). Settings next
to the chosen ones (60 to 120 ms of patience, a flow limit of 0.5 to 0.75 s) measure alike.
The gain is the recording's: over the unit benches below (`follower.test.ts` and
`sampled.test.ts`, 59 performances, 5,815 onsets) the share on time is 93.4 % → 93.5 %, ahead
0.10 % → 0.28 %, late by more than 0.4 s 2.6 % both ways. The two tables below were measured
before P36 and not rerun.

Why the P16 follower failed: every key and hammer adds a thump of 60–400 Hz, louder than soft
notes, that made events look broadband (the right group's cosine had a median of 0.36, the flat
burst's 0.44), and the templates expected partials 15–30 dB stronger than the piano gave. The
second pass decides an event 40 ms after it rose (`minAge`), when the thump has mostly faded, and
asks more of a place far ahead than of one behind (`jumpAhead`). What remains, by cause:

- *The thump masks the attack* (above G3 it is broadband up to about F#4): 2:04–2:13 (bars
  25–26.3, fast single high notes, the rise of A#3–C4 outweighs them; up to 1.4 bars behind),
  5:50–5:54 (bar 58.2–59, notes up to D#7 not explained).
- *Soft notes that open no event*, in long hesitations: 0:41–0:58 (bars 7.5–9.4, single C4,
  A3, G3; the truth there is weak too: contrasts of 5 dB), 4:13–4:18 (bar 47.1).
- *Identical groups in the score*: 1:06–1:11 (bars 10.8–11.6: attacks are taken as the same
  group struck again), 5:07 (bar 52.3: a stray chord in a hesitation equals a group two ahead;
  the truth may be wrong here, the matcher heard the next group at 5:03).
- *A replay*: 1:26–1:29 (bar 15 → 14, a replayed G4 is taken for the next group but one, 1.25
  bars ahead for 3 s), 3:52–3:58 (bar 46.5 → 45.9, the cursor waits half a bar behind).
- Shorter: 3:35 (bar 44.3, dense left hand), 0:13 (bar 3, repeated G5 ringing).

### Real piano sound (P16)

No recording of the user's piano existed then, so the redesign was measured on the next best
thing: performances rendered with the app's own sampled grand (`public/samples/salamander`,
decoded with ffmpeg; real hammer noise, inharmonicity and decay), through a room model
(reverberation, a microphone high-pass at 120 Hz, pink noise 43 dB under the piano's peak unless
stated) at 48 kHz, played the way a learner plays. Five pieces (the 24-bar generated piece, the
reference piece with its 736 onsets, an Alberti-bass piece with bars in identical pairs, a
chorale with repeated chords, sixteenth-note scales), 1,148 onsets in all per scenario. The
cursor is driven as the session drives it (forward only), and an onset counts as **on time**
when its gate was released between 150 ms before it was played and 150 ms after, **ahead** when
earlier than that. "First version" is the P14 follower with its reference built at 1×.

| Playing (five pieces, 1,148 onsets) | First version: on time | ahead | Now: on time | ahead | late by more than 0.4 s |
| --- | --- | --- | --- | --- | --- |
| Steady at tempo, no room (dry, noise −64 dB) | 99 % | 0 % | 93 % | 0 % | 2 % |
| Steady at tempo | 93 % | 6 % | 94 % | 0 % | 1 % |
| Steady at 0.6× tempo | 79 % | 21 % | 96 % | 1 % | 1 % |
| Steady at 1.3× tempo | 98 % | 1 % | 92 % | 0 % | 2 % |
| Stops of up to 3 s before 30 % of the notes, keys held | 7 % | 93 % | 96 % | 0 % | 2 % |
| The same stops, hands off the keys | 3 % | 97 % | 97 % | 0 % | 2 % |
| Learner at 0.7×: stops before 15 %, 3 % wrong notes, some struck twice | 22 % | 78 % | 96 % | 1 % | 1 % |
| Learner at 0.5×: stops before 30 %, 8 % wrong, 5 % struck twice, 5 % missing | 1 % | 99 % | 92 % | 4 % | 3 % |
| 10 % wrong notes, not corrected | 67 % | 32 % | 89 % | 1 % | 3 % |
| Going back six notes to repeat, twice | 70 % | 29 % | 91 % | 4 % | 1 % |
| Every note ringing a second longer (unmarked pedal) | 86 % | 9 % | 92 % | 1 % | 2 % |
| Pedal as marked in the score | 93 % | 7 % | 92 % | 1 % | 2 % |
| A very reverberant room | 65 % | 6 % | 91 % | 0 % | 2 % |
| Noise 28 dB under the piano, with thumps | 41 % | 6 % | 94 % | 0 % | 1 % |
| A faint recording (peak −30 dBFS, noise −62 dBFS) | 67 % | 2 % | 95 % | 0 % | 1 % |
| Five seconds of noise and thumps before the first note | 74 % | 24 % | 93 % | 0 % | 1 % |

Over all sixteen rows the first version was on time for 60 % of the onsets, ahead of the player
for 32 % and lost for good at 6 %; now 93.5 % on time, 0.9 % ahead, 1.6 % late by more than
0.4 s, never lost. The first version's cursor ran ahead whenever the player stopped (and so in
every learner scenario), because time warping against a tempo-based reference advances through
sustained sound, and its silence gate never closed in a room. Where it had nothing to wait for
it was better: steady playing in a dry, quiet recording (99 % against 93 %) and at 1.3× (98 %
against 92 %), and it answered sooner (a median of 34 ms after the attack against 51 ms). What
the new follower misses there are faint attacks in fast or pedaled passages (the reference
piece: 88–96 % by scenario, the four short pieces 97 % on average), which it reaches one note
late, not early. Its one bad row on a short piece is going back to repeat in the chorale, whose
chords repeat exactly: 33 % on time, the rest ahead (see "Limits").

`sampled.test.ts` keeps a part of this bench in the unit tests: the 24-bar piece on the sampled
grand through the same room model (steady playing at three speeds, a learner's stops and
mistakes, a noisy room, the pedal held through, a chord that rings on). It decodes the samples
with `ffmpeg` and is skipped where that is not installed.

### Synthetic performances (unit tests)

`follower.test.ts` plays the import fixtures, the 24-bar piece and, when present, the reference
piece through the additive synthesizer at 44.1 kHz: at least 90–95 % of the onsets within 150 ms
at 0.8×, 1× and 1.25× (and at 0.4× and 2×), none reached early; recovery within a second of
wrong and missing notes; rubato; the pedal held through; a learner's stops of up to four seconds
with keys held or released, also with noise 30 dB under the piano; a jump of a few bars forward
or back found after a few attacks; nothing heard in a chord that rings for five seconds or in
noise. The median delay is 41–44 ms (the bound in the tests is 90 ms).

P21 (the low cut, the decision frame, the steeper partials, the dearer skips) moved this bench up
or left it in place: the 24-bar piece 92–100 % on time by scenario as before, the reference piece
88–96 % → 90–98 %, with up to 2 % of the onsets ahead in three scenarios that had none (1.3×,
sustain held, 10 % wrong notes). The left hand alone (a one-hand play-through, `hands: 'left'`)
went from 98 % to 95 % on time steady, the right hand from 89 % to 95 %. The second pass (`minAge`, `jumpAhead`)
cost the reference-piece rows up to 2 points on time (pedal as marked 94 → 90 %, reverberant
90 → 87 %) and 1–3 % ahead, from one repeated triplet figure in bar 10 where a G3 at the low limit
is taken for its octave; the 24-bar piece and the one-hand rows moved by a point at most.

Cost in Node on a desktop core: about 0.11–0.16 ms per 10 ms frame, nearly all of it the 4096-point
FFT (matching runs only during events), so an estimated 0.6–1 ms per frame on the reference
tablet (4–6× slower), inside the budget of one worker. The templates of the 61-bar piece build
in about 12 ms; there is no tempo-dependent reference to rebuild.

## Limits

- Measured on one real recording only (one piano, one phone, AAC on the way; the live path has
  no codec), and there six onsets in ten are reached on time (the cursor is within a quarter
  bar of the player 86 % of the time): soft notes under the thump of
  the keys, notes of the left hand below G3 and repeated notes still ringing are often heard late,
  and a hesitation with stray attacks can carry the cursor a few groups ahead (up to 9 s before
  the player there). `recording.test.ts` locks in what was reached and skips without the
  private files; `MatcherOptions.trace` shows why each attack was or was not taken.
- Below G3 (`lowest`) nothing counts but partials: a lone low note may pass for its octave.
- Soft notes under a lot of ringing sound (heavy pedal), notes in fast runs and a note struck
  again while it still rings raise little: they are often heard one note late (the next clear
  attack skips over them). This is the weakest case: 89 % on time on the reference piece in the
  pedal scenarios, 85 % in the synthetic pedal test.
- FFT bins of about 11 Hz are wider than a semitone below G3: bass notes are told apart by their
  partials, less sharply than the middle of the keyboard (below C3 a note resembles its neighbor
  at about 0.5, itself at 0.7).
- A wrong note that happens to be the next note of the piece moves the position on, and so does
  the right note in the wrong octave (its partials are the expected note's). Nothing is judged,
  so this only matters for where the cursor is.
- Repeated material is ambiguous by nature: after a jump back in a piece whose bars repeat, the
  replayed notes also fit the bars ahead, and the cursor may move on with them (the first
  version did the same). A jump of more than 24 groups back or 32 ahead is not looked for; a
  seek sets the position.
- A voice or another instrument at the pitch of the next notes can pass for them.

## Wiring (DECISIONS P15, P16, P22)

Play-through follows the microphone whenever no piano input is connected (no setting), and with
one when the Practice menu's Follow choice (`settings.mic.follow`) says Microphone; any hand
(P22). With one hand the follower is built with `hands` ('right' / 'left': `attackGroups(model,
hands)` keeps that hand's notes by the practice timeline's `n.hand` rule, so its groups are the
one-hand timeline's and `groupReached` stays exact; `AudioFollowerOptions.hands`,
`configure.hands` in `protocol.ts`; absent means both) and the app plays nothing meanwhile.
`app/audio/micFollower.ts`: `getUserMedia({ echoCancellation: false, noiseSuppression: false,
autoGainControl: false, channelCount: 1 })` → an `AudioWorklet` (`public/mic-processor.js`,
512-sample mono blocks posted to the main thread) → `workers/follower.worker.ts` running
`workerHandler.ts` (`protocol.ts`: configure / reset / pause / resume / samples in; an estimate
out each time the group heard last changes, nothing in between) → the session's
`#onMicEstimate`, which calls `PlayFollower.audioReached(groupReached(timeline, position))` for
estimates at or past the current group. Nothing is judged. A seek resets the position, a pause
stops the samples and Start listens afresh; Speed is not passed on. The metronome is silent in a
play-through the microphone follows. A microphone that stops by itself pauses play-through with
the reason; the microphone is closed outside play-through. `tests/e2e/practice-mic.spec.ts` runs
the whole chain in the browser on a stream that plays a synthesized performance.
