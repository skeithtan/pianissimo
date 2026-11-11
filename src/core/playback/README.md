# core/playback — performance builder, musical transport, output backends

One musical scheduler for Preview/Listen, one-hand accompaniment and the metronome, with a
MIDI-output backend (default, the connected piano) and an explicitly chosen browser-audio
backend. Core logic never reads clocks or timers: inject `clock` (performance.now() ms) and
`timers`. Excluded from the worker tsconfig (uses DOM/Web Audio types).

## Public API (`index.ts`)

```ts
// What the app plays (sorted on/off/cc events; positions in whole notes + roll offsets at 1×)
passageRange(model, passage | null): { start, end }
buildPerformance(model, { hands, range?, accompanimentLevel?, sendPedals, listenFilter? }): PerformanceEvent[]
buildClickTrack(model, range): ClickEvent[]

// The transport
createTransport({ clock, timers?, tempo, multiplier, events, gates, range, backend,
  lookaheadMs? = 100, offLookaheadMs?, tickMs? = 25, stallMs? = 250,
  metronome?: { sink, clicks, enabled? }, onGateReached?, onRangeEnd?, onInterrupted?, onEmit? }): Transport
Transport: state, holdingGate, multiplier, play(at?), pause(), stop(), seek(pos), setMultiplier(m),
  releaseGate(i), positionNow(), msUntilGate(i, atTime), msUntilPosition(pos, atTime),
  setMetronomeEnabled(b), interrupt(), stopSound(), dispose()

// Backends
new MidiOutputBackend({ output, channel, clock, humanGuard? = true, releaseVelocity? = 64 })
  + humanInput(ev), resetHuman(), disconnected(), reconnect(output, now), ownedNotes(), deferredNotes()
loadBrowserAudio() → { createBrowserAudio({ clock?, volume?, onProgress? }), BrowserAudioBackend, … }
  BrowserAudioBackend: load(), stats() {status, transferredBytes, decodedBytes, …}, setVolume, monitor(ev), dispose
loadWebAudioMetronome() → { WebAudioMetronome } (a MetronomeSink)
sharedAudioContext(), isWebAudioSupported()
```

Test helpers (not exported): `testkit.ts` (`makeModel`, `ManualClock`, `RecordingBackend`),
`fakeWebAudio.ts`.

## Session wiring (for WP8)

- **Preview / Listen:** `buildPerformance(model, { hands: 'none', sendPedals: true, listenFilter, range })`,
  `gates: null`. Loop: on `onRangeEnd`, `seek(range.start)` + `play()`.
- **One-hand accompaniment:** `hands: 'right' | 'left'`, `sendPedals: route.automaticPedalsInHandPractice`,
  `gates = timeline.groups.map(g => g.position)`. `onGateReached(i)` → `engine.transportArrived(i)`;
  engine input complete for group i → `transport.releaseGate(i)`. Seek/restart → `transport.seek(pos)`
  + engine reset. Engine `transportEta: (group, t) => transport.msUntilGate(group, t)`.
- **Both-hand practice:** the same learner gates and clock as one-hand practice, with
  `events: []` and `backend: null`. No app-generated notes or sound backend are needed. The
  metronome follows this gated transport; its sink loads only when enabled.
- **Human input:** forward every human event to `MidiOutputBackend.humanInput`; construct the
  backend with `humanGuard: true` only on a route verified echo-free (an echoing or untested
  piano returns app notes as "held" keys that are never released); call `resetHuman()` on
  input reconnect. Optional monitoring: `browserBackend.monitor(ev)`.
- **Disconnect:** on `output-disconnected` call `transport.interrupt()` and
  `backend.disconnected()`; on `output-reconnected` call `backend.reconnect(adapter.output, now)`.
  A send failing first also interrupts (`onInterrupted('disconnect')`).
- **Mode or hand change:** `pause()` (cleanup) or `stop()`. Hiding the page only saves progress;
  the session leaves practice and Listen running.
- **Highlights:** `onEmit(ev, time)` reports every handed-out event and its scheduled time.

## Design notes

- **Performance builder.** Automatic hands: right → L, left → R, Preview → both (or the
  listen filter), both hands → nothing. Tie chains are one attack. A note already sounding at
  the range start is attacked at the start; releases are clipped to the range end. Automatic
  attacks in unison with a learner attack at the same onset are suppressed (a learner tie
  chain begun before the range start is not attacked there, E16, so it suppresses nothing);
  simultaneous automatic unisons merge (loudest velocity, latest release). Overlapping same-pitch notes
  keep separate on/off pairs (`voice` ids); backends count ownership. Velocity × accompaniment
  level (0 mutes notes). Pedals: CC 64/66/67; start/stop; change = up at P, down at P + 30 ms
  (scaled with tempo); stop+start at one position is a change; start while down is a re-pedal;
  passage starts with the pedal state in force and ends with pedals released. Order at one
  instant: releases, pedal up, pedal down, clicks, attacks.
- **Musical time** is a piecewise-linear map clock-ms → seconds-at-1× (`TempoIndex` maps to
  positions in O(log segments)). Reference offsets are seconds at 1× and scale by 1/multiplier.
- **Lookahead.** Attacks, pedals and clicks are handed out up to `lookaheadMs` ahead with
  timestamps. MIDI releases are handed out when due (`offLookaheadMs` 0) so the human-held
  guard is evaluated at release time and a queued release cannot cut a key pressed just before
  it; browser audio takes releases with the full lookahead so every event arrives in time order.
  The scheduler wakes exactly at the next due event, gate or end (≤ `tickMs`).
- **Gates.** No attack/pedal/click at or beyond the written position of the first unreleased
  gate is ever handed out, even inside the lookahead: what the automatic part plays at the
  learner's onset (chords, roll members, pedals, clicks) sounds with the learner's press, never
  before it. Events strictly before the gate play on time, even when their offset makes them
  sound after the gate position (they are ordered no later than that gate). At the gate:
  `onGateReached(i)`, then hold unless released. While holding, the musical clock keeps
  running "virtually" only so sounding notes receive their releases on schedule; the cursor
  stays at the gate.
  `releaseGate` while holding re-anchors musical time at now at the gate position, so the
  events written there are due at once and go out inside that same call (roll members keep
  their offsets from the release; no timer wait, no burst of later music, no replay).
  `releaseGate` before arrival (an early press accepted within the engine's grace)
  fast-forwards: the gate position becomes now, the music between the current position and
  the gate is handed out at once in order (nothing skipped), the gate is reached and reported
  through `onGateReached` exactly once (synchronously, before any later gate), and playback
  continues at tempo from the gate; `positionNow()` and `msUntilGate` reflect the jump at
  once. Attacks already handed out with the lookahead keep their times, and later attacks are
  never handed out before them (so after a fast-forward the gate's events may sound up to the
  lookahead later than now). Re-entrant calls from callbacks are safe.
- **Exactly once.** Attacks are consumed in order by one pointer; releases enter a pending set
  only when their attack went out. Pause/seek/stop forget what was handed out for later times
  (the backend cleanup canceled it) and re-hand it after resuming.
- **Live tempo.** `setMultiplier` keeps events already handed out at their times and starts the
  new speed after the last of them, so attacks, releases and pedals stay ordered; releases are
  never earlier than their attack (+1 ms).
- **Stalls.** A wake-up more than `stallMs` late (blocked main thread) shifts musical time
  instead of bursting overdue notes.
- **MIDI backend.** Per (channel, note) ownership counts; deferred releases while the human
  holds the pitch on the same channel; cleanup = `clear()` when present, note-offs for owned
  notes (after already queued attacks when there is no `clear()`, deferred releases included),
  release of app-pressed pedals — app channel only, never All Sound Off, Local Control,
  program changes or other channels. `stopSound` also sends CC 123 on the app channel. Sends
  after a failure throw `OutputLostError`; `reconnect` releases what was owned when the link
  dropped, including releases still deferred for a human-held key (kept while the output is
  lost).
- **Browser audio** (dynamic import only): one shared `AudioContext` created on first use
  after a gesture; Salamander bank from `${BASE_URL}samples/salamander/` per `manifest.json`;
  each sample decoded, downmixed to mono and cut to ≤ 5 s (less at high sample rates) with an
  80 ms fade so the bank stays ≤ 32 MiB decoded; nearest sample within 6 semitones +
  `playbackRate`; triangle synth while loading or on failure; sustain/sostenuto/soft pedals and
  re-strike damping; separate voices for optional input monitoring. The shipped bank is
  ≈ 2.0 MB transferred (test-checked ≤ 8 MB and ≤ 32 MiB at 44.1/48/96 kHz).
- **Metronome**: clicks are transport events (held back at and beyond an unreleased gate like any other); the Web
  Audio click is its own small lazily loaded module, usable with MIDI output.

## Spec coverage

| Item | Status |
| --- | --- |
| Preview of both parts / listening filters; hand practice sends the complementary part | ✅ |
| Tie chains, unison suppression, Preview unison merge, overlapping same-pitch notes | ✅ |
| Dynamics velocity × accompaniment level; pedals (Preview; hand practice only when allowed) | ✅ |
| Tempo map × multiplier, roll offsets scaled, live speed change without skips/duplicates/stuck notes | ✅ · 🔒 audible check |
| Lookahead never reaches an unresolved learner onset; the gate position sounds at release; early release fast-forwards | ✅ |
| Pause/stop/seek cleanup: queue clear, owned note-offs, app pedals on the tested channel only | ✅ (fakes) · 🔒 `clear()`/timestamp behavior per browser |
| Human-held deferral of app releases | ✅ · 🔒 whether the piano's local voice is affected |
| Stop sound; disconnect → stop scheduling; reconnect cleanup | ✅ · 🔒 USB/BLE unplug tests |
| Browser audio: one context, Salamander bank, mono/5 s/32 MiB, synth fallback, stats | ✅ (fake Web Audio) · 🔒 sound quality, iPad memory |
| MIDI-only use never loads the bank (dynamic import boundary, test-checked) | ✅ · build chunk check in WP8 |
| Metronome (free mode from first press; follows transport in accompaniment) | ✅ |
| Cursor position, range-end callback, ETA for the engine's early-press grace | ✅ |

## Decisions and interpretations

- Gates strictly before a seek position count as passed; a gate at the seek/start position is
  reached immediately on `play()` and holds; automatic notes at that position sound with the
  learner's first press (its release), not at `play()`.
- Pause/seek does not re-attack automatic notes that were sounding at that point; playback
  resumes with the next attack.
- `stopSound()` pauses the transport, forces releases (ignoring the human-held guard) and sends
  All Notes Off on the app channel only.
- Note-off velocity 64 ("no release velocity" convention).
- Accompaniment level 0 mutes notes; pedals still follow when enabled.
- Grace notes (zero duration, unsupported regions) are not played.
- Pedal change re-press gap 30 ms at 1×, scaled with tempo like other reference offsets.
- `msUntilGate` returns 0 once the transport has arrived at/passed the gate (even for an
  `atTime` before arrival); otherwise exact time from `atTime` on the current tempo map ×
  multiplier; null when not playing or behind an earlier unreleased gate.
