# views/practice — Practice view (WP10)

Lazily loaded from `app/views.ts` (`chrome: 'none'`). The view is a thin Preact layer over
`app/session`'s `PracticeSession`, which owns every live behavior.

Spec: "Practice screen" and the sections listed in `src/app/session/README.md`; DECISIONS
U1–U15 (look, damage-hit flash, fades, hand toggles, loop selector, overview + loop steppers,
speed stepper, dark mode, Listen = both hands off, Repeat mode, overview row, the 2026-10-30
redesign: no passage bar, receding chrome, Repeat panel + cursor repeat button, 88-key guide).

## Files

| File | Role |
| --- | --- |
| `PracticeView.tsx` | Entry. Reads `practiceRequest`; loads piece + package (`getStorage()`); missing piece → explanation + Back to Library. No request → empty state with Back to Library and up to five recently opened pieces. `PracticeViewWith({env})` for tests. A new import’s `autoStart` request is consumed once after layout preparation, then starts practice or Listen. |
| `PracticeScreen.tsx` | Builds the session (preset → else the piece's last hands / passage / speed; resume position when no passage), the piece saver, the settings subscription, `onBeforeApplyLabels`, `visibilitychange` → save progress without pausing, orientation → `viewChanged`; prepares the layout (`prepareLayout` + IndexedDB layout cache; re-prepared when `maxLabelWidthChars(naming)` changes) and mounts `StripView` (its cursor action → `session.repeatFrom(cursor bar)`); renders the layout. |
| `Footer.tsx` | Speed (`TempoControl`, popover opens upward) \| `HandToggles` around Start / Pause / Listen / Play (both off and unavailable without a connected piano, a tap toasts "Piano not connected", U27) \| Note names (Off / Conditional / All via `applyLabelSettings`), icon-only Hint and Show keys (U18). |
| `RepeatPanel.tsx` | Repeat mode only: a slim group floating at the top of the stage with `LoopSteppers` (Loop start / Loop end, one whole bar per press; steps act on the browsed bar while browsing, else the cursor's bar) and the Repeat-until target. Edges read "Bar 12" or "Bar 12, beat 3" (`edgeText`; note-level edges come from the strip's handles). It rises in with Repeat mode and sinks away (`leaving`, kept mounted by `useFadePresence`) when Repeat closes (U14). |
| `recede.ts` | `useRecede(playing, timers)`: the chrome fades while playing (after 1.2 s) and returns on pause / interruption, for 3 s after a pointer on it, and while keyboard focus is inside it. The overview never fades (U13 revised). |
| `live.tsx` | Per-frame subscribers: `OverviewBar` (`ScoreOverview` alone on its row), `OctaveFeedback` (up/down arrow only, in the stage margin), `GuidePanel` (`KeyboardGuide` in a `.guideSlot` whose grid row slides 0fr ↔ 1fr, `data-open`, so the stage follows smoothly; the guide fades with `useFadePresence` and stays mounted while the slot closes). |
| `Banners.tsx` | Over the preserved score, under the Repeat panel: piano disconnected ("Piano disconnected. Reconnect it to continue." + Connection; while it shows, the attempt's `disconnect` interruption is held back, then shows with its actions once the piano is back), sound status, "Continuing from bar N", interruption (Resume / Restart), waiting for released keys, Ready, and the attempt result card (status rail, title, streak, facts grid, Details → `openResults({pieceId, attemptId})` and Again; fades and rises in, fades and sinks out over `RESULT_FADE_MS`, showing the last result while it leaves). No end-of-piece banner: the footer's main button offers Start. |
| `TempoSheet.tsx` | Practice tempo entry when the score has none (saved as `PieceRecord.userTempo`). |
| `env.ts` | `PracticeEnv` seam (storage, MIDI, clock, timers, frames, prepare, createStrip, lazy loaders) and the production defaults. `PracticeStripOptions` = `StripOptions` (incl. `onCursorAction`, U14). |
| `browse.ts` | `useBrowsedBar`: the bar at the cursor's resting place (1/3 from the left) while the learner browses the strip; the loop steppers act on it (U6). Repeat mode opens from the cursor's repeat button (shown only outside Repeat mode; while playing it needs the chrome revealed) and closes with the strip's ✕ (U14, U17). |
| `format.ts`, `useStore.ts`, `practice.module.css` | Text helpers, store hook, styles (tokens only; landscape first, narrow screens wrap the footer tools above the hand cluster). |

## Layout

Header on the page background (back, title / composer, connection chip, Settings) → overview
row (only the overview) → stage: score paper, full width, no box or shadow, down to the footer
(strip, top overlay column with the Repeat panel and banners, octave arrow), with one 1 px
`--border` line on its bottom edge → keyboard-guide slot (slides open and closed) → footer. The
guide slot and the footer sit on the stage's `--score-paper`, so everything below the line is one
surface. The red vignette is `WrongNoteFlash`, which changes opacity only; the stage never shakes.
While playing, `data-recede="true"` on the screen fades every `.recedes` element (header tools,
footer tools, hand toggles, Repeat panel) to 12 % and makes it ignore pointers; its region
catches the tap that brings it back. The back button, the piece's title and composer, feedback
(flash, octave arrow, banners), the overview and the main button never recede.

Screenshots: `tests/e2e/practice.spec.ts` writes to `$TMPDIR/pianissimo-practice-shots`;
`PRACTICE_SHOTS=<dir> npx playwright test tests/e2e/practice-shots.spec.ts` writes idle, Repeat
mode and playing (receded, guide open) at 1180×820, 820×1180 and 360×780, light and dark.

## Tests

- `PracticeView.test.tsx` (happy-dom, fake-indexeddb, an imported fixture, fake MIDI/strip):
  empty state, timed reading + octave arrow, preset → Repeat mode + scored result + Results link,
  Labels control and Listen mode, Repeat panel only in Repeat mode (not in the overview row),
  browsed bar, no passage bar / Settings in the header / Speed and Labels in the footer, the
  cursor repeat button, receding chrome, remembered passage.
- `Banners.test.tsx` (happy-dom, `Banners` and `GuidePanel` with stub session stores): one
  disconnect notice at a time, no end-of-piece banner, the result card's fade in / out (Hide
  works, the last result stays while leaving), the guide slot's `data-open`.
- `tests/e2e/practice.spec.ts`, `practice-assist.spec.ts` (production build, injected fake Web
  MIDI, IndexedDB seeded with `two-hands.musicxml`; `loopWholePiece` helper): wrong-note flash
  + octave arrows, scored completion, result card, dark theme, portrait, MIDI-only practice never fetches
  `/samples/`, hints, labels, the 88-key guide live before Start, Repeat readiness, Results,
  Listen on MIDI, Listen without a piano through browser sound (Auto).

## Known gaps

- Real multi-touch, iPad timing and audible output remain 🔒.

Practice follows the same musical clock as Listen, holds at each required onset, and resumes
when its pitches are accepted (P9). The cursor stays fixed at one third of the viewport; all
movement belongs to the notes (U28). Hiding the document saves progress without interrupting
practice or Listen (P10); Settings/Connection still pause and isolate input.
