# src/ui — design tokens and shared controls

Small purpose-built controls (no component suite), system fonts, CSS Modules. Every interactive
control is at least 44 px (`--touch` = 48 px). Color is never the only cue.

## Tokens (`global.css`)

Color (light, dark via `prefers-color-scheme` and `[data-theme]`; surfaces `--bg` <
`--bg-elevated` and `--bg-sunken` < `--bg-raised`, stepping lighter with elevation in dark mode;
accent as text `--accent` versus fill `--accent-fill` + `--accent-fg`; `--scrim`, A17), **type scale** (`--text-xs`
… `--text-2xl`), **spacing** (`--space-1` … `--space-7`), **elevation** (`--shadow`,
`--shadow-sheet`, `--shadow-toast`), z-layers (`--z-bar`, `--z-flash`, `--z-toast`) and **motion**:

| Token | Use |
| --- | --- |
| `--dur-fast` 140 ms, `--dur-base` 200 ms, `--dur-slow` 300 ms | state changes, entrances |
| `--dur-hint-fade` 300 ms | label / hint fades (spec default) |
| `--ease-standard`, `--ease-out`, `--ease-in` | transitions, entrances, decays |

`prefers-reduced-motion` shortens the durations (never zero: a short fade still signals change) and
stops keyframe movement. `motion.ts` mirrors them for JS (`HINT_FADE_MS`, `fadeDuration`,
`prefersReducedMotion`).

## Controls (`controls.tsx`)

`Button`, `Segmented` (radio group with arrow keys and roving tab index), `Toggle`, `Field`,
`Slider`, `Sheet` (modal dialog that fades, restores focus; `wide`, `tall`, `flush`), `Notice`. No big shadows (U12): sheets, the tempo popover and the selected segment use a 1 px `--border` edge.
`icons.tsx` adds `hand`, `handLeft`, `plus`, `minus`, `forward`.

## Fades (`fade.tsx`) — hints and overlays never vanish abruptly

- `useFadePresence(visible, ms)` -> `{ mounted, phase, style }`: stays mounted while opacity
  transitions to 0, then unmounts; showing again mid-fade cancels the removal and the opacity
  returns from where it was.
- `<Fade show ms>` wrapper, and `useFadeList(items, ms)` for keyed lists (toasts).
- Used by toasts, `Sheet`, the capability banner, the tempo popover and overlays. Use it
  for the keyboard-guide panel hide too. Reduced motion shortens the fade to 90 ms.

## Practice controls

| Component | Notes |
| --- | --- |
| `WrongNoteFlash` | Full-viewport, pointer-inert red damage vignette with a transparent center. Drive with `trigger` + `until` or `onReady(handle)` → `hit(now?, untilMs?, { soft? })` / `clear()`. `soft` (a too-early press) peaks at `SOFT_FLASH_PEAK` (0.35) with an 80% decay and never lifts a full flash already showing (two layers, the larger shows). One rAF loop writes opacity only; there is no shake, scaling or view transform. The envelope rises in ~50 ms and decays over ~300 ms; repeat attacks extend it without strobing. No generic wrong-key chip (U30). |
| `HandToggles` | `[left hand] [Start / Pause / Listen] [right hand]` with `hands: HandSelection`, `onHandsChange`, `playing`, `onPlayPause`, `playLabel?`, `handsDisabled?`, `playDisabled?`, `handClass?` (extra class on the two hand toggles; Practice fades them while playing). Both on = both, one = that hand, none = Listen (`none`). No caption (U12): `aria-pressed`, L/R badge, tooltip, hand color tokens. Pure helpers: `handsFromToggles`, `playButtonLabel`. |
| `ScoreOverview` | Slim scrubbable bar for the whole unfolded piece: `measures` (`{start, duration}` in whole notes), `position`, `loop`, `onScrub(occ)` (rAF-throttled; tap seeks at once), `disabled`, `describe`. `role="slider"` with `aria-valuetext` "Bar 12 of 59", arrow / Home / End keys. Playback only changes two transforms; the tick path is built once per `measures`. Loop is inclusive of both bars (a note-level loop's exact `start` / `end` are placed inside their bars, linear in time, `loopExtent(…, start?, end?)`), outlined in `--color-loop`. Optional `onLoopChange(loop)`: the shown loop gets two edge handles (`role="slider"`, "Overview loop start" / "Overview loop end", test ids `overview-loop-start` / `overview-loop-end`) that drag a whole bar at a time (rAF-throttled, once per bar change, final value on release; `dragLoopEdge`) or step with Left / Right; the dragged edge drops its note-level position, the other keeps it; never crossing, never leaving the piece. A handle press never seeks. |
| `LoopSteppers` + `loopStep.ts` | "Loop start" / "Loop end" with whole-bar steps only (‹ ›, one chevron each): `[‹] value [›]`, all 44 px (U22 revised 2026-10-31). `currentOcc` is the bar under the cursor line in the current view (the browse position while inspecting). No loop: only start-earlier (creates `[cur-1, cur]`) and end-later (creates `[cur, cur+1]`) work. With a loop: a step moves an edge to the next barline (a note-level edge set with the strip's handles first snaps to its own bar's barline), never past the other edge (one-bar minimum) or out of `0..lastOcc`. `edgeLabel(loop, edge)` names note-level edges ("Bar 12, beat 3"). Pure `stepLoop`, `loopStepAvailability`. |
| `TempoControl` + `speed.ts` | `[-] 100% / ♩ = 72 [+]`; hold to repeat after 400 ms; 5-point grid (off-grid values step to the next grid value), 5%–400%. Tap the value for presets 50–200 %, slider, custom entry as multiplier / percent / BPM of the shown beat unit (`parseSpeedInput`; rejects zero, negative, non-finite, unparseable, out of range), reset. `noTempo` shows "Set tempo…" and calls `onRequestTempo`. Pure `stepMultiplier`, `parseSpeedInput`, `formatSpeedPercent`, `formatBpm`. |

The Practice view decides what a change means during a scored attempt (interrupt) for tempo,
loop and hand changes: these controls only report them.

## Tests

`*.test.ts(x)` beside each module (happy-dom for components; `views/shared/testing.ts` has the
helpers). `npx vitest run src/ui`.
