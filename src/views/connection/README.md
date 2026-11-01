# views/connection — Connection and Pedal Setup

Spec: "Main user journey" step 3, "MIDI input, output, and pedal controls", "Delivery and
device compatibility", the hardware test protocol (private docs). Shown as a **large modal over the current
view** (`ConnectionModal.tsx`: a wide `Sheet`; the view underneath stays mounted). The connection
chip in the app bar and the Practice header opens it (`openConnection()`); Back, Escape and the
close button close it; `#/connection` deep-links to it over the Library. Its content is the lazy
chunk `ConnectionView` (`overlayScreens` in `app/views.ts`, ~14 kB gzip), fetched on first open. All MIDI state comes from `app/services.ts`
(`getMidiService()`); nothing here owns the adapter.

## Layout

A checklist header (remembered route + three step buttons with text status), then the steps
as cards (DECISIONS C11: access and input are one step, playback / echo / accompaniment
options are one step, the hint pedal is the third). ≥ 980 px: steps on the left, the sticky **Live input** panel on the right; narrower:
one column with Live input right after the Input step. Every step works on its own; status is
an icon/ring plus text (never color alone). Theme tokens only (test-checked), so light, dark
and `data-theme` all follow; mini-keyboard keys stay `--paper`/`--ink`.

| Step | File | What it does |
| --- | --- | --- |
| 1 Your piano | `PianoStep.tsx` | Until granted: MIDI access — unsupported (MIDIWeb on iPad / Chrome on a computer), prompt (explicit Allow button), denied (how to re-allow, Try again), error. Then: input radio cards, remembered tag, "remembered piano not connected", disconnected warning. Always: connection type USB / Bluetooth / Not sure → `route.connection`, pairing guide (USB, 5-pin wiring, BLE paired by OS/MIDIWeb, BT audio insufficient). |
| Live input | `LivePanel.tsx`, `MiniKeyboard.tsx`, `Meter.tsx`, `liveMonitor.ts` | 88-key strip (held = fill by velocity + dot, sustained = dashed), Note on/off/pedal counters with Reset (fidelity checks), a meter per controller seen (value, range, continuous vs on/off, threshold), last 12 events. Re-render ≤ once per frame; new pedal controllers → `pedal.observedControllers` from the frame. |
| 2 Playback to the piano | `PlaybackStep.tsx` | Output radio cards + "No output", receive channel 1–16, **Play test notes** = the echo probe (`runEchoTest` on the app channel) → "Did the piano itself play three short notes?" Yes/No → `route.outputVerified`; the probe's verdict none / echo detected / inconclusive (kept previous) → `route.echo` (`echoSetting`), stored only when the piano input was connected during the test. No → channel / cable direction / port-is-not-proof guidance; echo detected → what it disables and how to fix it; echo unchecked → play again with the input connected. Browser sound is a separate explicit choice. Below: accompaniment level, "Send score pedals in one-hand practice" (default off, explained), Stop sound (`service.stopSound()`). |
| 3 Hint pedal | `HintPedalStep.tsx`, `hintPedalFlow.ts` | Listen → detect (middle pedal preferred, also when pressed after another) → test press (one trigger per press; counter shows holding never retriggers) → Save → `pedal.hintPedal`. Missing middle pedal and sustain-pedal cautions, sound caveat, action Note names / Show keys, advanced inversion + threshold (needs a new test). |
| Exit | `ConnectionView.tsx` | "Done" closes the modal (the title is the sheet's header). |

Pure helpers: `status.ts` (step statuses), `format.ts` (event rows, pedal names); `testkit.ts` (manual clock for the test notes' listening window).

## Behavior notes

- Opening the view reads the permission without prompting; if it is already `granted` the
  view connects at once (no prompt can appear), otherwise it waits for **Allow MIDI access**.
- MIDI input reaches only `LiveMonitor.handle` (O(1)) and, while active, the hint-pedal flow;
  both re-render through `requestAnimationFrame`.

## Status

Done (happy-dom + unit tests: 52): every row above. Not done / left:

- Visual review: Playwright screenshots in light/dark at 1180×820, portrait and phone widths
  were **not** taken in this session (dark mode is token-only and render-tested only).
- 🔒 Real-hardware checks (hardware test protocol §1–2): which CCs/ranges pianos send, BLE ids,
  audible test note, echo on real routes.
- The pairing / denied texts are generic for MIDIWeb (its exact settings UI is unverified).

Tests: `ConnectionView.test.tsx`, `PlaybackStep.test.tsx`, `liveMonitor.test.ts`,
`hintPedalFlow.test.ts`, `status.test.ts`. Run `npx vitest run src/views/connection`.
