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
  pitches' semitone energies: 16 partials at 1/h power, spread over FFT bins by the window's own
  response (`windowLobe`) and binned exactly as live frames are.
- **Matching** (`matcher.ts`, `OnsetMatcher`, one `step` per frame):
  1. *Rise.* Each semitone has a baseline that falls with the sound (60 dB a second at most:
     the dips of beating partials are not followed, so their return is no attack) and rises
     toward it by a fifth per frame. Energies are log-compressed against a level reference: the
     running peak (20 dB a second decay), never less than 20 dB over the noise floor, which is
     read across the spectrum (the quietest tenth of the semitones from G3 up) so it is known
     even while notes sound. When the norm of the excess over the baselines passes 1.2 an
     **event** opens; it ends when the rise has fallen back or after 100 ms.
  2. *Evidence.* The event's observed rise is the loudest energy each semitone reached over the
     energies just before it. A group's expected rise is what its template would add to those
     same energies, so notes already ringing are discounted, at the best of four loudness
     scales. Their cosine is the group's evidence. The same cosine against a flat spectrum
     recognizes a broadband burst (a thump, a click): no group gets evidence above it.
  3. *Position.* A score per position is updated at each event as in a Viterbi step: the event
     is unexplained (free: nothing moves), or it is the attack of group `c` reached from the
     group before it, from up to four groups earlier (skipped or unheard notes, 0.05 of cosine
     each) or from itself (struck again, 0.1). Positions up to 24 groups behind and 32 ahead of
     the best one are kept within the worth of two or three clear events of it, so a run of
     attacks that fits elsewhere (the player skipped a line, or went back to repeat a bar)
     takes over after a few of them, never after one. While one of the next groups is clearly
     it (cosine ≥ 0.65, a margin over every other outcome) the event is decided before it ends.
  4. *Chords that arrive in parts* (rolled, or one hand late). For half a second after its
     latest notes the group heard last is open: an event that raises new semitones and makes
     everything struck since the group began fit it clearly better is more of it, at no price.
     An event nothing explains is kept for a moment and read together with the next one.
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

### Real piano sound (P16)

No recording of the user's piano exists yet, so the redesign was measured on the next best
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

Cost in Node on a desktop core: about 0.16 ms per 10 ms frame, nearly all of it the 4096-point
FFT (matching runs only during events), so an estimated 0.6–1 ms per frame on the reference
tablet (4–6× slower), inside the budget of one worker. The templates of the 59-bar piece build
in about 12 ms; there is no tempo-dependent reference to rebuild.

## Limits

- Not proven on real piano sound through a tablet microphone. `recording.test.ts` scores a
  recording with a hand-timed onset list dropped into the unpublished
  `tests/fixtures/private/audio/` folder (its README says how; acceptance bar: 75 % within
  150 ms) and skips without one. `MatcherOptions.trace` shows why each attack was or was not
  taken, which is how to tune against such a recording.
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

## Wiring (DECISIONS P15, P16)

Settings → Sound → Microphone → "Follow an acoustic piano", both hands only.
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
