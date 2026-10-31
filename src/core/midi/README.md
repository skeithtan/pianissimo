# core/midi — Web MIDI adapter, decoding, routing, hint pedal, echo test

Main-thread MIDI input and route setup. Framework-free; DOM types only through the structural
Web MIDI shapes in `webmidi.ts` (Chrome's `MIDIAccess` and MIDIWeb's polyfill both fit them).
Excluded from the worker tsconfig.

## Public API (`index.ts`)

| Export | Purpose |
| --- | --- |
| `MidiInputEvent`, `CC_*` (`types.ts`, shared contract) | Decoded, sequenced input events (consumed once by the engine). |
| `MidiAdapter` | Feature detection, `request()` (sysex off, one in-flight request), `permission()` (`granted`/`denied`/`prompt`/`unknown`), `inputs()`/`outputs()`, `selectInput`/`selectOutput`, `output` (connected selected port or null), `subscribe` (decoded events, in order), `onRoute` (input/output disconnected/reconnected), `onPortsChanged`, `onStatus`, `physical`, `lastSeq`, `dispose`. |
| `isWebMidiSupported`, `MIDI_*_EXPLANATION`, `MIDI_BLUETOOTH_HINT` | Status texts for the Connection view. |
| `MidiDecoder`, `noteOnBytes`/`noteOffBytes`/`ccBytes` | Byte decoding with a monotonically increasing `seq`; output byte builders. |
| `PhysicalState` | Held keys per channel, keys sounding only through sustain, controller values, `isClean()`, release/change listeners. |
| `HintPedalLearner`, `HintPedalConfirmation`, `HintPedalTrigger`, `withInversion`, `withThreshold` | "Set hint pedal": learn controller/channel/threshold/inversion, confirm with a test press, fire once per press. |
| `EchoDetector`, `runEchoTest`, `echoSetting`, `DEFAULT_PROBE` | Output echo test. |
| `playTestNote` | "Play test note" on the selected output/channel. |
| `findRememberedPort`, `applyRememberedRoute`, `rememberRoute`, `gradedAccompanimentAllowed` | Route memory and the graded-accompaniment rule. |
| `fakeWebMidi.ts` (not exported) | Test fakes: ports, access with `statechange`, recording output. |

## Design notes

- **Input path is O(small).** `onmidimessage` → `MidiDecoder.decode` → `PhysicalState.apply` →
  subscribers, synchronously and in order. No allocation beyond the emitted event objects.
  Timestamps are `MIDIMessageEvent.timeStamp` (performance.now() timebase); a missing or
  foreign-timebase stamp is replaced by the injected clock.
- **Decoding** handles several messages per buffer, running status, real-time bytes anywhere
  (also between data bytes), SysEx and system common. A message interrupted by a new status
  byte is dropped. Note On velocity 0 → `noteoff`. Aftertouch, program change, pitch bend are
  ignored. One decoder per adapter, so `seq` is unique across ports and reconnections.
- **Physical vs sounding.** `PhysicalState` keeps held keys (bitmask per channel), keys still
  sounding only through sustain, and raw controller values. All Notes Off and mode messages
  (CC 123–127) from the instrument release that channel's keys.
- **Disconnect/reconnect.** `statechange` for the selected input detaches the handler, resets
  physical state and emits `input-disconnected`; a port coming back with the same id, or the
  same name (Bluetooth ports may get new ids), is re-attached and emits `input-reconnected`.
  Outputs emit the same pair; `adapter.output` is null while lost.
- **Hint pedal.** The learner tracks every controller (except bank select and channel-mode
  messages), proposes the one with the largest swing but prefers CC 66 when usable, sets the
  threshold at the midpoint of the observed range, and infers inversion from a baseline, the
  first message of an on/off switch, or the first movement of a continuous pedal. The trigger
  uses a hysteresis band (≤ 8, from the observed range) so a held, wobbling pedal never
  retriggers.
- **Echo test.** Three probe notes (C♯4, F♯4, A♯4 at velocities 37/83/59) on the tested
  channel. Two returned probe pitches, or one exact echo (pitch + channel + velocity), mean
  `echo-detected`; one returned pitch at another velocity is `inconclusive` (could be a human
  press — repeat the test); nothing returned is `none`. The detector only observes: live
  subscribers still receive every event. It never filters live input.

## Spec coverage

| Item | Status |
| --- | --- |
| Feature detection, permission flow (sysex off), unsupported/denied/prompt states | ✅ |
| Separate input/output lists, selection, route memory by id then name | ✅ |
| `statechange` disconnect/reconnect, physical state reset on reconnect | ✅ |
| Note On/Off, vel-0 release, velocity, channel, timestamps, continuous pedal values | ✅ |
| Every event sequenced and delivered once, in order (MIDI fidelity) | ✅ (fake input) · 🔒 USB + BLE on the piano |
| Physical keys vs sustained sound; clean-state check | ✅ |
| Hint pedal learning, once-per-press, inversion, threshold, missing middle pedal text | ✅ · 🔒 which CCs/ranges the real piano sends |
| Echo test without discarding human presses; graded accompaniment rule | ✅ · 🔒 real route echo behavior |
| Play test note | ✅ · 🔒 audible confirmation is by the user on the piano |
| BLE pairing | Not done by the site (OS/browser), per spec; `MIDI_BLUETOOTH_HINT` explains it |

## Decisions and interpretations

- `gradedAccompanimentAllowed` requires a verified output **and** echo `none`; an untested
  route does not grade accompaniment (Preview still works).
- An `inconclusive` echo verdict leaves `MidiRouteSettings.echo` unchanged (`echoSetting` → null).
- A port matched only by name may be a different device: `applyRememberedRoute` reports how
  each port was matched so the caller can ask for re-verification.
