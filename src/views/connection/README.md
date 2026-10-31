# views/connection — Connection and Pedal Setup

Spec: "Main user journey" step 3, "MIDI input, output, and pedal controls", "Delivery and
device compatibility", the hardware test protocol (private docs). Shown as a **large modal over the current
view** (`ConnectionModal.tsx`: a wide `Sheet`; the view underneath stays mounted). The connection
chip in the app bar and the Practice header opens it (`openConnection()`); Back, Escape and the
close button close it; `#/connection` deep-links to it over the Library. Its content is the lazy
chunk `ConnectionView` (`overlayScreens` in `app/views.ts`, ~14 kB gzip), fetched on first open. All MIDI state comes from `app/services.ts`
(`getMidiService()`); nothing here owns the adapter.

## Layout

A checklist header (remembered route + six step buttons with text status), then the steps
as cards. ≥ 980 px: steps on the left, the sticky **Live input** panel on the right; narrower:
one column with Live input right after the Input step. Every step works on its own; status is
an icon/ring plus text (never color alone). Theme tokens only (test-checked), so light, dark
and `data-theme` all follow; mini-keyboard keys stay `--paper`/`--ink`.

| Step | File | What it does |
| --- | --- | --- |
| 1 MIDI access | `AccessStep.tsx` | Unsupported (MIDIWeb on iPad / Chrome on a computer), prompt (explicit Allow button), denied (how to re-allow, Try again), error. Pairing guide: USB, 5-pin wiring, BLE paired by OS/MIDIWeb, BT audio insufficient. |
| 2 Piano input | `InputStep.tsx` | Input radio cards, remembered tag, "remembered piano not connected", disconnected warning, connection type USB / Bluetooth / Not sure → `route.connection`. |
| Live input | `LivePanel.tsx`, `MiniKeyboard.tsx`, `Meter.tsx`, `liveMonitor.ts` | 88-key strip (held = fill by velocity + dot, sustained = dashed), Note on/off/pedal counters with Reset (fidelity checks), a meter per controller seen (value, range, continuous vs on/off, threshold), last 12 events. Re-render ≤ once per frame; new pedal controllers → `pedal.observedControllers` from the frame. |
| 3 Playback | `OutputStep.tsx` | Output radio cards + "No output", receive channel 1–16, Play test note → "Did the piano itself play a note?" Yes/No → `route.outputVerified`; No → channel / cable direction / port-is-not-proof guidance; browser sound is a separate explicit choice. |
| 4 Echo test | `EchoStep.tsx` | `runEchoTest` on the app channel; verdict none / echo detected / inconclusive (kept previous) in plain language; `echoSetting` → `route.echo`. |
| 5 Hint pedal | `HintPedalStep.tsx`, `hintPedalFlow.ts` | Listen → detect (middle pedal preferred, also when pressed after another) → test press (one trigger per press; counter shows holding never retriggers) → Save → `pedal.hintPedal`. Missing middle pedal and sustain-pedal cautions, sound caveat, action Note names / Show keys, advanced inversion + threshold (needs a new test). |
| 6 Accompaniment | `PlaybackStep.tsx` | Graded-accompaniment checklist (`playbackReadiness`), accompaniment level, "Send score pedals in one-hand practice" (default off, explained), Stop sound (`service.stopSound()`). |
| Exit | `ConnectionView.tsx` | "Done" closes the modal (the title is the sheet's header). |

Pure helpers: `status.ts` (step statuses, readiness), `format.ts` (event rows, pedal names).

## Behavior notes

- Opening the view reads the permission without prompting; if it is already `granted` the
  view connects at once (no prompt can appear), otherwise it waits for **Allow MIDI access**.
- MIDI input reaches only `LiveMonitor.handle` (O(1)) and, while active, the hint-pedal flow;
  both re-render through `requestAnimationFrame`.

## Status

Done (happy-dom + unit tests: 48): every row above. Not done / left:

- Visual review: Playwright screenshots in light/dark at 1180×820, portrait and phone widths
  were **not** taken in this session (dark mode is token-only and render-tested only).
- 🔒 Real-hardware checks (hardware test protocol §1–2): which CCs/ranges pianos send, BLE ids,
  audible test note, echo on real routes.
- The pairing / denied texts are generic for MIDIWeb (its exact settings UI is unverified).

Tests: `ConnectionView.test.tsx`, `EchoStep.test.tsx`, `liveMonitor.test.ts`,
`hintPedalFlow.test.ts`, `status.test.ts`. Run `npx vitest run src/views/connection`.
