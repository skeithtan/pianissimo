# core/audio — audio score follower (spike)

Estimates where the player is in a score from microphone samples, so Play-through (DECISIONS
P12) could follow an acoustic piano without MIDI. A spike on branch `mic-follower-spike`
(DECISIONS P14): pure, synchronous, framework-free TypeScript with no DOM, no Web Audio and no
new dependency, proven on synthetic performances only so far; wired into play-through by P15.

Position only: from a microphone the follower cannot tell a wrong note from a right one, and
Play-through does not need it to. Both hands only: the microphone must never hear the app's own
playback of the other hand.

## Pipeline

```
samples ─► FeatureExtractor ─► OnlineTimeWarping ─► framePosition ─► groupReached
            (features.ts)        (oltw.ts)             (reference.ts)    (index.ts)
                                   ▲
                   buildReference(model, tempo, multiplier, sampleRate)
```

- **Features** (`features.ts`): 2048-sample Hann frames (46 ms) every 10 ms, an in-repo radix-2
  FFT, power summed into one bin per piano semitone (MIDI 21–108). The vector has two halves,
  each unit-normalized: the **LSE** half, `log(1 + 1000·E/Emax)` per semitone plus a presence
  constant (silence is presence only), and the **onset** half, the half-wave-rectified
  frame-to-frame rise of log energy per semitone plus a steady constant, which tells repeated or
  pedaled attacks apart where the LSE cannot. The dot product of two vectors is
  `LSE_SHARE` × LSE cosine + (1 − `LSE_SHARE`) × onset cosine; `LSE_SHARE = 0.8`.
  A frame 45 dB under the running peak (20 dB/s decay) or under −60 dBFS is silence.
- **Reference** (`reference.ts`): the expected feature sequence of a `ScoreModel` at the tempo
  map × multiplier, one frame per 10 ms, from a harmonic template per pitch (8 partials at 1/h²
  power, spread over FFT bins by the Hann main lobe and binned exactly as live frames are), a
  decay by pitch, a 60 ms release, and notes under a marked sustain pedal ringing to its lift.
  No audio is synthesized; the energies go through the same `FrameEncoder`. 50 silent lead-in
  frames let a follower wait for the first note.
- **Alignment** (`oltw.ts`): windowed online time warping after Arzt and Widmer. Per live frame
  `t` and reference frame `j`: `D(t, j) = c(t, j) + 0.99 · min(D(t−1, j−1), D(t−1, j) + 0.02,
  D(t−1, j−2) + 0.02)` with `c = 1 − dot`, computed for 100 frames behind to 300 ahead of the
  best match; the position is the row's argmin. Each live frame advances 0, 1 or 2 reference
  frames (0–2× the score tempo); the 0.99 forgetting (about a second) lets the match recover
  after wrong notes. A silent live frame while the matched reference frame sounds **holds** the
  position: a player who stops is waited for, the reference never runs on. Confidence is a
  smoothed `1 − c` of the best match (act above about 0.5).
- **Follower** (`index.ts`): `createAudioFollower(model, tempo, multiplier, options?)` →
  `push(samples, sampleRate, time)` returning `{ position, confidence, time, frames }`
  (position in float whole notes; `time` the stream time of the end of the last analyzed frame)
  and `reset(position?)`. `groupReached(timeline, position)` gives the last `Timeline` group at
  or before a position, for a session to call `PlayFollower.transportArrived` when it rises.

| Entry point | Purpose |
| --- | --- |
| `createAudioFollower(model, tempo, multiplier, options?)` | The follower. Builds the reference lazily for the first sample rate seen; a new rate rebuilds at the current position. |
| `groupReached(timeline, position)` | `Timeline` group index at or before a float position (−1 before the first). |
| `FeatureExtractor`, `Fft`, `FEATURE_DIM`, `HOP_SEC`, `frameSize`, `hopSize` | Feature internals (tests, a future worklet). |
| `buildReference`, `referenceNotes`, `sustainSpans`, `frameAt`, `framePosition` | Reference internals. |
| `OnlineTimeWarping` | The aligner (`step(vector, onset, silent)`, `reset(frame, spread)`). |
| `evaluate.ts`, `testkit.ts` | Test support: `perform` (a perturbed performance from a score: tempo factor, ±15 ms jitter, wrong and missing notes, a pause, rubato, pedaling as marked or notes ringing longer), `renderNotes` (an additive synthesizer that deliberately differs from the templates: inharmonic partials at 0.6^h with per-partial decay, random velocities, −70 dBFS noise), `evaluate` / `evaluateAudio` (onset-reaching metric). |

## Measured (synthetic performances, reference built at 1×)

Share of onsets reached within 150 ms (the time of the first estimate at or past the onset
minus the true attack; the median of about 25 ms is mostly the 23 ms half window). Mistakes =
one wrong note at 30 % and 60 % of the piece and one missing note at 45 %. `follower.test.ts`
asserts the bounds below; the private reference piece has 736 onsets and 113 pedal marks.

| Piece | 0.8× | 1× | 1.25× | with mistakes | recovered 1 s after |
| --- | --- | --- | --- | --- | --- |
| six short fixtures (6–12 onsets) | 100 % | 100 % | 100 % | 50–100 % | 100 % (rolls: last onset) |
| 24-bar generated piece (132 onsets) | 100 % | 100 % | 100 % | 99 % | 100 % |
| reference piece, no pedal | 96 % | 100 % | 100 % | 95–100 % | 96–100 % |
| reference piece, pedal as marked | 99 % | 99 % | 97 % | 96–99 % | 98–100 % |

| Condition (reference piece unless noted) | within 150 ms | within 500 ms |
| --- | --- | --- |
| every note ringing 0.5 s longer than written (unmarked pedal) | 97 % | 100 % |
| every note ringing 1 s longer (unmarked pedal) | 89 % | 98 % |
| ±30 % rubato over an 8 s period | 99 % | 100 % |
| 24-bar piece at 0.5× / 1.6× / 2× | 99 % / 98 % / 89 % | 99 % / 100 % / 97 % |
| 24-bar piece with a 2 s stop in the middle | 100 % | 100 % |

Short pieces with mistakes score low only because the one or two onsets right after a mistake
lag by 0.2–1.6 s before the forgetting catches up; on long pieces that is a handful of onsets.

Cost in Node on a desktop core: 0.08–0.12 ms per 10 ms frame (features + alignment), so an
estimated 0.5–0.7 ms per frame on the reference tablet (4–6× slower), well inside the budget of
one worker. The reference of the 59-bar piece (22,000 frames) builds in about 0.2 s.

## Limits

- Not proven on real piano sound through a tablet microphone (room, noise, the app's own UI
  sounds). `recording.test.ts` scores a recording with a hand-timed onset list dropped into the
  unpublished `tests/fixtures/private/audio/` folder (its README says how; acceptance bar: 75 %
  within 150 ms) and skips without one.
- FFT bins of about 22 Hz are wider than a semitone below A4: bass fundamentals land in a
  neighboring bin, live and reference alike, and the partials do the discriminating.
- The window follows the best match: a jump back of more than a second or forward of more than
  three seconds is lost until a `reset` (a seek). Identical repeated passages rely on the
  one-second forgetting horizon.
- Pedaling the score does not mark is the weakest case (table above).

## Wiring (DECISIONS P15)

Settings → Sound → Microphone → "Follow an acoustic piano", both hands only.
`app/audio/micFollower.ts`: `getUserMedia({ echoCancellation: false, noiseSuppression: false,
autoGainControl: false })` → an `AudioWorklet` (`public/mic-processor.js`, 512-sample mono
blocks posted to the main thread) → `workers/follower.worker.ts` running `workerHandler.ts`
(`protocol.ts`: configure / reset / pause / resume / samples in, estimates every 20 ms of audio
out) → the session's `#onMicEstimate`, which calls `PlayFollower.audioReached(groupReached(timeline,
position))` for estimates with confidence ≥ 0.5 at or past the current group. Gates are never
released from audio below that confidence; nothing is judged. Speed and hand changes rebuild the
follower at the current position as they rebuild the transport; the microphone is closed outside
play-through.
