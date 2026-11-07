# render/keyboard — keyboard guide (spec "Keyboard rescue", DECISIONS U15)

A display-only Preact component for the bottom panel of the practice screen: the **whole 88-key
piano** (A0–C8), top-down, in one SVG. Every highlighted key gets a translucent bar in its part's
color and its note name above it. It owns no timers and reads no MIDI; the practice session
(`app/session/guide.ts`) builds the keys once per frame and publishes them only on change.

```tsx
import { KeyboardGuide } from '../render/keyboard';

<KeyboardGuide
  keys={[
    { midi: 48, state: 'sounding', hand: 'L', label: 'C3', held: false }, // Listen / accompaniment
    { midi: 60, state: 'accepted', hand: 'R', label: 'C4', held: true },  // played, still held
    { midi: 64, state: 'target', hand: 'R', label: 'E4', held: false },   // to play
    { midi: 66, state: 'wrong', hand: null, label: 'F♯4', held: true },   // wrong key held
  ]}
  rollDirection="up"   // marked arpeggio of the group, if any
  visible={open}       // false fades out over fadeMs, then stays mounted but hidden
  fadeMs={settings.hints.fadeMs}
  naming={settings.naming} // octave landmarks follow letter / fixed do and si / ti
/>
```

## Public API (`index.ts`)

| Export | Purpose |
| --- | --- |
| `KeyboardGuide` | The component. Props in `types.ts` (`KeyboardGuideProps`). |
| `GuideKey`, `GuideKeyState` | `{ midi, state, hand, label, held }`; states `wrong` > `target` / `accepted` > `sounding` > `held`. `label` is already formatted with the naming settings. |
| `PIANO` | `{ low: 21, high: 108 }`. |

## Module map

| File | Role |
| --- | --- |
| `KeyboardGuide.tsx` / `.module.css` | Root: measures width, memoizes the plain keys, labels and summary; fade; `role="img"` label. |
| `Keys.tsx` | Plain white / black key layers and the octave landmarks (built once per width). |
| `Highlights.tsx` | Per-key bars and held dots (white-key bars under the black keys, black-key bars over them), note-name chips with leaders, roll arrow. |
| `labels.ts` | `placeGuideLabels`: chips centered over their keys, stacked into three lanes or slid sideways (`placeLabels`); keys beyond A0–C8 point at the edge. |
| `layout.ts` | Key geometry (`buildLayout`), `placeLabels`. |
| `metrics.ts` | `PIANO`, label lanes, `keysHeight(whiteWidth)` (52–96 px), tick / cross paths. |
| `landmarks.ts` | `keyName`: bare key name with octave regardless of the octave preference (also used by Connection). |
| `describe.ts` | Accessible text summary ("Play: C4, E4. Sounding: C3. Wrong keys held: F♯4."). |
| `useElementWidth.ts` | Width of the panel in CSS pixels (ResizeObserver, window-resize fallback). |

## Design notes

- **Whole piano, no hand indicator** (user, 2026-10-30): no enlarged window, no locator, no L/R
  chips, no fingering. Color comes from the part (`--color-left-hand`, `--color-right-hand`; a
  neutral slate for no hand, a unison or a key the score does not have).
- **Never color-only.** Target: solid outline. Played target (kept after release): dashed
  green outline and a tick in its label. Wrong held key: red bar and a cross in its label.
  Physically held: a dot near the bottom of the key, independent of the rest. Sounding (Listen,
  the accompaniment): a plain filled bar.
- **Labels** use the naming settings (accidentals, enharmonic simplification, fixed do, octave
  preference): score notes as written (`PersistentLabels.texts`), other keys with sharps.
  Landmarks always show their octave (K1); keys narrower than 14 px name only middle C.
- **Constant height per width**: three label lanes and the roll gap are always reserved; key
  height follows the white-key width, so the panel never jumps while playing.
- **Cheap updates on the iPad**: the plain keys and landmarks are memoized elements (Preact skips
  them), so an update diffs only the few highlighted keys; the session publishes at most once
  per frame and only when the keys changed (`sameGuideKeys`).
- **Fade**: `visible=false` fades to 0 over `fadeMs`, then `visibility: hidden` and `aria-hidden`.
- **Theming**: tokens only (test-checked, no literal colors). Keys stay `--paper` / `--ink` in
  dark mode; chips follow the theme.

- **Phones (DECISIONS U75):** `labels: false` draws no name chips and reserves no rows for
  them; the keys start right under the roll arrow's strip (`keysTop(false)`), so the panel is
  the keys alone (`boardHeight(whiteWidth, false)`). The octave landmarks stay. The caller
  decides (`views/practice/live.tsx` passes `!usePhone()`).

## Tests

`KeyboardGuide.test.tsx` (happy-dom; width simulated by stubbing `clientWidth`): 88 keys, bars
and labels, state shapes, dense clusters at 340 px, roll, landmarks, plain keys reused across
updates, fade. `metrics.test.ts`, `layout.test.ts`, `tokens.test.ts`; the key list itself is
tested in `app/session/guide.test.ts`.
