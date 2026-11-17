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
| `PracticeScreen.tsx` | Builds the session (preset → else the piece's last hands / passage / speed; resume position when no passage), the piece saver, the settings subscription, `onBeforeApplyLabels`, `visibilitychange` → save progress without pausing, orientation → `viewChanged`; prepares the layout (`prepareLayout` + IndexedDB layout cache; re-prepared when `maxLabelWidthChars(naming)` changes, when the label room `labelRoom(labels.mode)` changes (Off = tight 'hints', else 'all'; the old view stays until the new one is ready, holding names turned on, then hands its `respaceSnapshot` to the new view's `respaceFrom` glide at once, DECISIONS R3 revised; layouts come from the screen's in-memory `MemoryLayoutCache` before IndexedDB; after `PREPARE_AHEAD_MS` of idle the other room's layout is prepared ahead, and a switch waits for that run instead of engraving twice; a run prepared ahead is canceled through its `signal` in the same task as pointer or keyboard input on the screen (except on the Menu buttons and the Note names row, marked `data-keeps-ahead`) or a key on the piano, and also when playback starts, when its parameters no longer apply and when the screen unmounts, unless a label switch has adopted it; it starts again after an idle period without input or playback that doubles with every canceled run, `prepareAheadDelay`: 1.5 s up to 24 s, since a canceled run starts from nothing and holds the main thread again), on a rotation, and in portrait when the page width `pageWidthFor(stage, view.pageZoom)` changes) and mounts `StripView` (landscape) or `PageView` (portrait; zoom persists as `view.pageZoom`, the strip's as `view.zoom`) (its cursor action → `session.repeatFrom(cursor bar)`); renders the layout. Add to library's auto-start never starts a microphone play-through (P22: without a piano the screen opens ready and the learner's Start opens the microphone). |
| `Footer.tsx` | `FooterBar` (the shell, U90: `start`, `end`, `center` children, optional `zone` / `receded`; the one-row grid, the narrow-window wrap and `data-testid="footer-tools-slot"`), shared with Study's footer. `Footer` fills it: start side: Speed (`TempoControl`, popover opens upward, always visible) \| `HandToggles` around Start / Pause / Listen / Play (both off and unavailable without a connected piano only when this browser cannot use a microphone either, a tap toasts "Piano not connected", U27, P22; with a microphone the hands stay available and play through it) \| End side: Menu (`FooterMenu`). The on-screen Hint button is removed (U53), with automatic and pedal hints retained. |
| `FooterMenu.tsx` | `PracticeMenuItems` (the Note names / Play through / Keep time / Metronome / Show keys rows, shared with the phone's menu sheet, U80) and the footer's Menu button (end side) with its anchored popover (U76, never a modal sheet): Note names (Off / Conditional / All via `applyLabelSettings`), the Play through switch (P12; on and unavailable without a piano, `ui.playThroughLocked`, with the line from `playThroughNote`: "No piano connected: following the microphone." / one hand: "…the other hand stays silent.", P22), the **Follow** row (U92: a compact `Segmented` Piano / Microphone on `ui.follow`, shown when `ui.micSupported`; Piano unavailable without a piano; a choice calls `updateSettings({ mic: { follow } })`), the Keep time switch (P13; disabled while the hands are off or unavailable, without a numerical tempo or without a piano, then "Needs a connected piano."; the session keeps it exclusive with Play through, so turning one on turns the other off), the Metronome switch (U87, P20: one `metronome: { on, disabled, note }` object plus `onMetronome`, computed once in `PracticeScreen` for both hosts; it shows and edits the preference the mode uses, `ui.metronomeScope`, via `metronomeOn` / `metronomePatch`, so with Keep time on it is `metronome.keepTime`, else `metronome.enabled`; turning it on first calls `env.primeAudio`; disabled without a numerical tempo, without Web Audio or while `ui.metronomeMuted`, when it reads off and shows "Silent while the microphone follows.") and the Show keys switch (keyboard guide). While Keep time is on the Menu button carries a small metronome badge (`metronome` icon, `aria-hidden`; the switch itself carries the state), so the mode shows with the menu closed. Opens upward, kept on screen by `usePopoverPlacement`; closes on Escape, a press outside, the button, playback starting and the chrome receding. The button and popover are `FooterMenuPopover` (`label`, `closed?`, `badge?`, children; row classes as `footerMenuClasses`), which Study's footer reuses with its own rows and never forces shut (U90); `FooterMenu` passes "Practice menu", `closed={ui.playing \|\| receded}`, the badge and `PracticeMenuItems`. `LABEL_OPTIONS` (the Note names choices) is exported for Study. |
| `RepeatPanel.tsx` | Repeat mode only: a slim group floating at the top of the stage with `LoopSteppers` (Loop start / Loop end, one whole bar per press; steps act on the browsed bar while browsing, else the cursor's bar) and the Repeat-until target, followed by an icon-only Clear loop button (U61) using the same action as the score’s ✕, then the speed ladder: a "Speed ladder" select (Ladder: off, or "Ladder to N%" for the speed presets and 100% above the current speed, plus the ladder's own goal; the step is fixed at the stepper's 5%, `LADDER_STEP`) → `session.setLadder`, and while it is on a short status beside it ("Ladder 60% → 100%", or "Goal reached" in the success color; `ladderGoals`, `ladderLine`). At 360 px portrait the ladder wraps to its own row. Edges read "Bar 12" or "Bar 12, beat 3" (`edgeText`; note-level edges come from the strip's handles). It rises in with Repeat mode and sinks away (`leaving`, kept mounted by `useFadePresence`) when Repeat closes (U14). |
| `recede.ts` | `useRecede(playing, timers)`: the chrome recedes while playing (after 1.2 s) and returns on pause / interruption, Tab navigation, for 3 s after a pointer on it, and while keyboard focus or a tool dialog is inside it. The overview never fades (U13/U60). |
| `ScoreSkeleton.tsx` | Score preparation placeholder (U62): one grand staff in landscape, stacked systems in portrait, score theme colors, a polite progress status, and a subtle pulse disabled for reduced motion. Replaces the spinner without changing the preparation lifecycle. |
| `live.tsx` | Per-frame subscribers: `OverviewBar` (`ScoreOverview` alone on its row, or `inline` in a phone's top bar, U80; a position chosen on it seeks, then ends browsing in the score view so the cursor line shows it), `OctaveFeedback` (up/down arrow only, in the stage margin), `GuidePanel` (`KeyboardGuide` in a `.guideSlot` whose grid row slides 0fr ↔ 1fr, `data-open`, so the stage follows smoothly; the guide fades with `useFadePresence` and stays mounted while the slot closes). |
| `Banners.tsx` | Over the preserved score, under the Repeat panel: piano disconnected ("Piano disconnected. Reconnect it to continue." + Connection, the only disconnect message while it shows: the sound-status line is hidden and `MidiService` skips its toast, U71; the attempt's `disconnect` interruption never shows: once the piano is back no disconnect message remains and the footer's main button reads Resume when reading), sound status, interruption (Resume / Restart), waiting for released keys, Ready (not in Keep time: the count-in replaces it) (`Banners`), and the attempt result (`AttemptResult`, U97), rendered by `PracticeScreen` in the stage's bottom dock (`data-testid="result-dock"`), never over the reviewed passage: one slim pill with a badge (check for a clean pass, else the count of wrong notes), the headline (`resultTitle`: "Clean pass", "2 wrong notes", "Timing slipped", "Played with help", "Completed"), the Repeat goal as dots, one status line (Keep time's `timingText` "On time 38 of 42 · 3 late · 1 missed", "N clean in a row", `ladderResultText` "Speed up: next at 65%" / "Back to 55%" / "Goal reached: 100%", "Goal reached. Repeat is off."), the optional note line (the first of `lastResult.repeatedMistakes`, P24, worded by `repeatedMistakeLine` with the practiced model and the naming settings, which `PracticeScreen` passes: "F instead of F♯ in bar 12, three passes running"), then Again (outside Repeat or once the goal ended it), Details (icon) → `openResults({pieceId, attemptId})` and Hide; fades and rises in, fades and sinks out over `RESULT_FADE_MS`, showing the last result while it leaves. No saved-position banner (U57): reopening a piece silently restores its position. No end-of-piece banner: the footer's main button offers Start. |
| `reviewInset.ts` | `useReviewInset(dock, overlays, stripRef)`: a `ResizeObserver` on the result dock and the top overlay column hands the strip the height from the stage's bottom to the dock's top and from the stage's top to the overlays' bottom, each plus 8 px (`reviewInsetFor`, `reviewTopFor`, 0 without them) through `StripHandle.setReviewInset`, so the review after a pass (U97) keeps the card clear of the staves; a strip created later gets the last value. |
| `CountIn.tsx` | The Keep time count-in (P13): `ui.countIn`, the beats left, as a large number in a translucent paper disc centered over the stage (`role="status"`, "Count-in: 3"; tokens only; a gentle pop per beat, none under `prefers-reduced-motion`). Inside the stage, under the banners, pointer events pass through; it never covers the footer's hand toggles or main button. |
| `TempoSheet.tsx` | Practice tempo entry when the score has none (saved as `PieceRecord.userTempo`). |
| `env.ts` | `PracticeEnv` seam (storage, MIDI, clock, timers, frames, prepare, createStrip, lazy loaders) and the production defaults. `primeAudio?()` creates or resumes the shared AudioContext inside the tap that turns the Metronome switch on (iPadOS starts one only during a gesture; production: `sharedAudioContext()` when Web Audio is supported, never throws). `PracticeStripOptions` = `StripOptions` (incl. `onCursorAction`, U14). `createStrip(host, layout, options, mode?)`: `'page'` mounts `PageView` (portrait), otherwise `StripView`; `StripHandle.cursorClientX?()` gives a moving cursor's x. `createMicFollower?` / `micSupported?` (P22): the microphone follower and whether this browser can open a microphone; absent, `PracticeScreen` uses the real ones (`app/audio/micFollower.ts`). |
| `useOrientation.ts` | `useOrientation()` (`matchMedia('(orientation: portrait)')`, any device) picks the score view: portrait → page mode, landscape → strip. `useStageWidth(ref)` measures the stage for the page width. |
| `browse.ts` | `useBrowsedBar`: the bar at the cursor's resting place (1/3 from the left) while the learner browses the strip; the loop steppers act on it (U6). Repeat mode opens from the cursor's repeat button (shown only outside Repeat mode; while playing it needs the chrome revealed) and closes with the strip's ✕ (U14, U17). |
| `format.ts`, `useStore.ts`, `practice.module.css` | Text helpers, store hook, styles (tokens only; one footer row on tablets in both orientations, windows of 640 px or less wrap the footer tools above the hand cluster). |

Starting from the footer or another session entry point resolves the renderer's exact browsed
cursor position and restores following (U52). Landscape adopts the onset beneath the fixed
line. Portrait returns to its moving cursor without treating a page scroll as a seek. This
also applies after sound loading. The bar-only `useBrowsedBar` remains for loop steppers.

Note-name spacing transitions follow playback throughout the glide (U63). A rapid reversal
prepares its layout immediately, then awaits the current view's `whenRespaced()` before
replacing it. The effect's live guard discards superseded choices. Conditional ↔ All shares
one layout, and the existing scored-attempt interruption rules remain.

## Layout

**Phone-size screens (U80, `usePhone` / `usePhoneLandscape` from `views/shared`):** no header and
no footer. One 52 px top bar (`data-testid="practice-bar"`) holds Back, the title (upright) or
the overview in its place (on its side; the title is a visually hidden h1), the compact hand
toggles around Start / Pause and Menu. The menu is a `Sheet`
with Speed, Note names, Play through, Keep time, Metronome, Show keys (upright only), the connection chip
and Settings. Why Start is unavailable is a pill over the score. In focus mode the whole bar
slides up, fades and its row collapses like the tablet header (U93: it sits in the same
`.headerSlot` / `.headerClip`, `data-testid="practice-bar-slot"`, inert while hidden), on its side
with the overview; any pointer press on the score brings it back without seeking (that tap's
`onSeekRequest` is dropped), as do pause, interruption, end and Tab. A tap while the bar shows
seeks as before. A phone on its side has no keyboard
guide at all. In portrait the page is prepared with `pageMaxWidth` and shown with `fitWidth`
(R17): it never scrolls sideways. Everything below describes tablets and desktops.


Header on the page background (back, title / composer, connection chip, Settings) → overview
row (only the overview) → stage: score paper, full width, no box or shadow, down to the footer
(strip, top overlay column with the Repeat panel and banners, octave arrow), with one 1 px
`--border` line on its bottom edge → keyboard-guide slot (slides open and closed) → footer. The
guide slot and the footer sit on the stage's `--score-paper`, so everything below the line is one
surface by default. The guide and footer use `--practice-surface`, which follows the interface
theme even when the user pins the score paper to light. The red vignette is `WrongNoteFlash`,
which changes opacity only; the stage never shakes.
While playing, `data-recede="true"` slides the whole header upward as it fades (U60); the footer
is one row on every tablet, upright or on its side, and its tools dim in place (U66, U88). Only a
window 640 px wide or less wraps the tools into a row above the hand cluster, and in portrait
that row slides down and collapses. The header row collapses so the score gains height without
re-engraving or replacing its view. Hidden rows are inert.
Hand toggles and the Repeat panel retain their 12 % fade. The overview, feedback (flash, octave
arrow, banners), and main playback button stay visible. Pause, a touch on the stage, a pointer
near the cursor or controls, or keyboard navigation restores the chrome. Keyboard focus and an
open Speed dialog keep it available. Speed's upward popover is not clipped when the row is open.

The Olive styling keeps the piece title at 18 px and composer at 12 px, separated by 1 px,
with a 60 px header and 6 px vertical / 20 px horizontal padding (U53). The desktop footer is 84 px (the unchanged 68 px play control plus
8 px padding above and below); its horizontal padding is 20 px, or 12 px on narrow screens.
The tempo stepper is unboxed with a compact value, while its popover and all speed behavior
remain intact. Note names options have 12 px horizontal padding at their existing height.
The overview keeps its internal ticks, section markers and in-bar readout, with rounded ends
and no outer outline; the Repeat panel has no outline or bottom divider (U43–U48). Its native
Repeat-until select uses a decorative CSS chevron inset 14 px from the end (U53).

Screenshots: `tests/e2e/practice.spec.ts` writes to `$TMPDIR/pianissimo-practice-shots`;
`PRACTICE_SHOTS=<dir> npx playwright test tests/e2e/practice-shots.spec.ts` writes idle, Repeat
mode and playing (receded, guide open) at 1180×820, 820×1180 and 360×780, light and dark.

## Tests

- `PracticeView.test.tsx` (happy-dom, fake-indexeddb, an imported fixture, fake MIDI/strip):
  empty state, timed reading + octave arrow, preset → Repeat mode + scored result + Results link,
  a repeated mistake on the result pill after three passes (reworded live on a naming change),
  Labels control and Listen mode, Repeat panel only in Repeat mode (not in the overview row),
  browsed bar, no passage bar / Settings in the header / Speed and Labels in the footer, the
  cursor repeat button, receding chrome, remembered passage, the speed ladder select (goals,
  status line, saved on the piece), the Keep time switch (exclusive with Play through, the Menu
  badge, saved on the piece, Start shows the count-in over the stage, Pause clears it).
  The Metronome switch (off by default, edits `metronome.enabled` and primes audio once, the Keep time
  preference with Keep time on, disabled without Web Audio, the phone sheet's row). Without a
  piano (P22): with `env.micSupported` false the hands are held (U27); with a fake
  `env.createMicFollower` the hands stay available, Play through is on and locked with its note,
  Follow reads Microphone with Piano unavailable, Start opens the microphone for both hands and,
  after a hand change, for that hand.
  `RepeatPanel.test.ts`: ladder goals and status text.
- `tests/e2e/practice-review.spec.ts` (U97): a five-bar loop of a generated score completed at
  1194×834 zooms out to show the whole loop, the result covers none of its notes or marks, the
  first notes of the next pass are matched at once and the zoom comes back exactly; Hide ends
  the review and the saved zoom is untouched; the same wrong key three passes running puts "D♭
  instead of D♮ in bar 1, three passes running" on the pill (P24). `LOOP_REVIEW_SHOTS=<dir>`
  saves mid-review and settled screenshots at 1194×834, 834×1194, 390×844 and 852×360, light and
  dark, and the pill with that line at 1194×834 and 390×844.
- `FooterMenu.test.tsx` (happy-dom, `PracticeMenuItems` with a stub): the Metronome row's state and
  its muted rendering (disabled, description); the Follow choice (edits `settings.mic.follow`,
  Piano unavailable without a piano, hidden without a microphone), Play through locked with its
  note, Keep time's "Needs a connected piano.", `playThroughNote`.
- `tests/e2e/practice-mic.spec.ts`: no MIDI, default settings: Play through already on and locked,
  Follow on Microphone, Start follows a fake microphone stream through the real worklet and worker.
- `tests/e2e/practice-metronome.spec.ts`: the switch's states per preference, and real clicks counted
  through `AudioContext.createOscillator` (Keep time clicks past the count-in; off leaves only the
  count-in's four; ordinary reading with it off makes none), and the Study menu's Metronome switch
  (U90).
- `Banners.test.tsx` (happy-dom, `Banners` and `GuidePanel` with stub session stores): one
  disconnect notice at a time, no end-of-piece banner, the result card's fade in / out (Hide
  works, the last result stays while leaving, no time / first try / help facts), the headline
  and badge (`resultTitle`), the goal dots, Again only once the goal ends Repeat, the note line (worded from `repeatedMistakes`, letters and fixed do),
  the ladder line, the Keep time timing line (`timingText`) and no Ready banner in Keep time, the `CountIn` display, the guide slot's
  `data-open`.
- `tests/e2e/practice.spec.ts`, `practice-assist.spec.ts` (production build, injected fake Web
  MIDI, IndexedDB seeded with `two-hands.musicxml`; `loopWholePiece` helper): wrong-note flash
  + octave arrows, scored completion, result card, dark theme, portrait, MIDI-only practice never fetches
  `/samples/`, hints, labels, the 88-key guide live before Start, Repeat readiness, Results,
  Listen on MIDI, Listen without a piano through browser sound (Auto).
- `tests/e2e/practice-cursor.spec.ts`: first and resumed Listen sound the exact onset browsed
  backward to, notation follows, reading accepts that onset, and keyboard seeking starts
  from the visible note. `practice-page.spec.ts` also checks resumed following after scrolling.

## Portrait page mode

In portrait the stage shows the page view: systems wrapped to the width, the page still while a
line is played, the cursor moving along it with the round repeat button, the page scrolling to
put the next system a quarter down. A rotation is a layout change (`session.layoutChanging()`:
a running scored attempt is interrupted, reading continues), then the other layout is prepared
(cached) and the session re-attaches the new view at the same position with the loop and hands.
Header, overview, banners, keyboard guide (at the bottom when on) and footer are unchanged.
`tests/e2e/practice-page.spec.ts` (820×1180): several systems, playing moves the cursor in the
first system without scrolling, a seek to a late bar scrolls the page.

## Known gaps

- Real multi-touch, iPad timing and audible output remain 🔒.

Practice follows the same musical clock as Listen, holds at each required onset, and resumes
when its pitches are accepted (P9). The cursor stays fixed at one third of the viewport; all
movement belongs to the notes (U28). Hiding the document saves progress without interrupting
practice or Listen (P10); Settings/Connection still pause and isolate input.
