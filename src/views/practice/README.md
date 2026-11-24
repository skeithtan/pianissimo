# views/practice — Practice view, the score screen (WP10)

Lazily loaded from `app/views.ts` (`chrome: 'none'`). The view is a thin Preact layer over
`app/session`'s `PracticeSession`, which owns every live behavior.

Spec: "Practice screen" and the sections listed in `src/app/session/README.md`; DECISIONS
U1–U15 (look, damage-hit flash, fades, hand toggles, loop selector, overview + loop steppers,
speed stepper, dark mode, Repeat mode, overview row, the 2026-10-30 redesign: no passage bar,
receding chrome, Repeat panel + cursor repeat button, 88-key guide) and U141 (one score screen per
piece with four modes: Listen, Wait, Keep time, Follow).

## Files

| File | Role |
| --- | --- |
| `PracticeView.tsx` | Entry. Reads `practiceRequest`; loads piece + package (`getStorage()`); missing piece → explanation + Back to Library. No request → empty state with Back to Library and up to five recently opened pieces. `PracticeViewWith({env})` for tests. A request's `mode` (an old study link, `app/routes.ts`) is how the screen opens, over the piece's own mode, which stays until the learner chooses another. |
| `PracticeScreen.tsx` | Builds the session (preset → Repeat mode over its passage, and that opening state (`lastPassage`, `lastHands`, `lastMultiplier`, `repeatOpen`) is saved on the piece at once, so a reload reopens what is on screen (DECISIONS U98; the router does not apply a preset again at boot); else the piece's last hands / passage / speed, with Repeat mode reopened over `lastPassage`, paused at the loop start, when `repeatOpen` is true and a loop is stored (the resume position is then not used, nor changed); otherwise Repeat closed from the resume position), the piece saver, the settings subscription, `onBeforeApplyLabels`, `visibilitychange` and `pagehide` (Safari may not report a reload as hidden) → save progress without pausing, orientation → `viewChanged`; prepares the layout (`prepareLayout` + IndexedDB layout cache; re-prepared when `maxLabelWidthChars(naming)` changes, when the label room `labelRoom(labels.mode)` changes (Off = tight 'hints', else 'all'; the old view stays until the new one is ready, holding names turned on, then hands its `respaceSnapshot` to the new view's `respaceFrom` glide at once, DECISIONS R3 revised; layouts come from the screen's in-memory `MemoryLayoutCache` before IndexedDB; after `PREPARE_AHEAD_MS` of idle the other room's layout is prepared ahead, and a switch waits for that run instead of engraving twice; a run prepared ahead is canceled through its `signal` in the same task as pointer or keyboard input on the screen (except on the Menu buttons and the Note names row, marked `data-keeps-ahead`) or a key on the piano, and also when playback starts, when its parameters no longer apply and when the screen unmounts, unless a label switch has adopted it; it starts again after an idle period without input or playback that doubles with every canceled run, `prepareAheadDelay`: 1.5 s up to 24 s, since a canceled run starts from nothing and holds the main thread again), on a rotation, and in portrait when the page width `pageWidthFor(stage, view.pageZoom)` changes) and mounts `StripView` (landscape) or `PageView` (portrait; zoom persists as `view.pageZoom`, the strip's as `view.zoom`) (its cursor action → `session.repeatFrom(cursor bar)`); renders the layout. Follow's microphone (`createMicFollower`, `micSupported`) comes from `env` or `app/audio/micFollower.ts` and opens on Start only. Opening saves nothing but a preset's state. The main button reads Play / Pause in Listen and Start / Pause / Resume otherwise. The disconnect banner is passed to `Banners` only where the mode is played on the piano (not in Listen, nor in Follow over the microphone). |
| `Footer.tsx` | `Footer`: start side: Speed (`TempoControl`, popover opens upward, always visible) \| `HandToggles` around the main button, with the mode's words (`handToggles`: Listen “you hear it” / “silent”, the others “you play it” / “the piano plays it”, or “silent” while the microphone follows) and the reason it is unavailable under them \| end side: Menu (`FooterMenu`). `StartReason` (`ui.startReason`, hidden while something plays) has Connect piano beside it when only a piano is missing: Wait and Keep time without one, Follow where the browser has no microphone either; on a phone it is a pill over the score. The on-screen Hint button is removed (U53), with automatic and pedal hints retained. |
| `FooterMenu.tsx` | `PracticeMenuItems`, shared with the phone's menu sheet (U80), in this order: Note names (Off / Conditional / All via `applyLabelSettings`), with Choose which notes under it in Conditional (`openNoteRules`, U143); Playback and its volume (Keep time only, with a piano and a tempo, P27); Follow input Piano / Microphone (Follow only, where the browser can use a microphone; edits `settings.mic.follow`, U92); Metronome (U87, P20: one `metronome: { on, disabled, note }` object plus `onMetronome`, computed once in `PracticeScreen` for both hosts; it shows and edits the preference the mode uses, `ui.metronomeScope`, via `metronomeOn` / `metronomePatch`; turning it on first calls `env.primeAudio`; disabled without a numerical tempo, without Web Audio or while `ui.metronomeMuted`, when it reads off and shows "Silent while the microphone follows."); Show keys (keyboard guide); Progress (U148); Record performance (U136). `FooterMenu` is the footer's Menu button (end side) with its anchored popover (U76, never a modal sheet): opens upward, kept on screen by `usePopoverPlacement`; closes on Escape, a press outside, the button, the chrome receding, and playback starting except in Listen. |
| `ModeControl.tsx`, `modeFit.ts` | The mode (U141). `ModeChoice` (a `Segmented`, each option titled by its description), `ModeButton` (the mode with a chevron, “Mode: Wait. Change”), `ModeTitle` (an upright phone's title block) and `ModeSheet` (a floating, untitled sheet with the modes as radio rows; arrow keys move the focus, a choice closes it). `useModeFit` decides what the header shows (Layout, below). The words are in `views/shared/modes.ts`. Every choice calls `session.setMode`. |
| `RepeatPanel.tsx` | Repeat mode only. `LoopSteppers` moves each edge by a whole bar, from the browsed bar while browsing or the cursor's bar otherwise. The score handles can also set note-level edges. The goal button opens `RepeatOptions`, which uses a popover on tablets and a sheet on phones. Turning on the speed ladder selects 100% of the written tempo. At or above 100%, choosing that goal starts at 75%. The goal button shows the climb or “Goal reached.” The exit clears the loop and closes Repeat (U61). The controls rise in and sink away with Repeat mode (`useFadePresence`, U14). |
| `recede.ts` | `useRecede(playing, timers)`: the chrome recedes while playing (after 1.2 s) and returns on pause / interruption, Tab navigation, for 3 s after a pointer on it, and while keyboard focus or a tool dialog is inside it. The overview never fades (U13/U60). A tablet's or desktop's header keeps its place and its contents fade, upright or on its side (U147); only a phone's top bar collapses (U93). `PracticeScreen` passes `ui.playing && !ui.reviewing`: no focus mode while the loop is reviewed after a pass (U102), though Repeat waiting at Ready counts as playing; the next pass's first correct note ends the review and focus follows after the delay. In Listen nothing recedes on any screen size (U72, U141): the screen ignores the receded state there except for the cursor's repeat button, which goes while it plays as in the other modes (U14). |
| `ScoreSkeleton.tsx` | Score preparation placeholder (U62): one grand staff in landscape, stacked systems in portrait, score theme colors, a polite progress status, and a subtle pulse disabled for reduced motion. Replaces the spinner without changing the preparation lifecycle. |
| `live.tsx` | Per-frame subscribers: `OverviewBar` (`ScoreOverview` alone on its row, or `inline` in a phone's top bar, U80; a position chosen on it seeks, then ends browsing in the score view so the cursor line shows it), `OctaveFeedback` (up/down arrow only, in the stage margin), `GuidePanel` (`KeyboardGuide` in a `.guideSlot` whose grid row slides 0fr ↔ 1fr, `data-open`, so the stage follows smoothly; the guide fades with `useFadePresence` and stays mounted while the slot closes). |
| `Banners.tsx` | Over the preserved score, under the Repeat panel: piano disconnected ("Piano disconnected. Reconnect it to continue." + Connect piano, the only disconnect message while it shows: the sound-status line is hidden and `MidiService` skips its toast, U71; the attempt's `disconnect` interruption never shows: once the piano is back no disconnect message remains and the footer's main button reads Resume when reading), sound status, interruption (Resume / Restart), waiting for released keys, Ready (not in Keep time: the count-in replaces it) (`Banners`), and the attempt result (`AttemptResult`, U97), rendered by `PracticeScreen` in the stage's bottom dock (`data-testid="result-dock"`), never over the reviewed passage: one pill with an up chevron, the cut-off top of its card, and a badge (check for a clean pass, else the count of wrong notes), the headline (`resultTitle`: "Clean pass", "2 wrong notes", "Timing slipped", "Completed"; help never keeps a pass from being clean and is not mentioned, U144), the Repeat goal as dots, one status line (Keep time's `timingText` "On time 38 of 42 · 3 late · 1 missed", "N clean in a row", `ladderResultText` "Speed up: next at 65%" / "Goal reached: 100%", "Goal reached. Repeat is off."), the optional note line (the first of `lastResult.repeatedMistakes`, P24, worded by `repeatedMistakeLine` with the practiced model and the naming settings, which `PracticeScreen` passes: "F instead of F♯ in bar 12, three passes running"), then ✕. The pill has no other action (U142): under the summary it is the top of the card, cut off at its bottom edge (`peek`: `ResultPeek`, a fixed `--result-peek` tall per size, fading over 8 px, 12 px of air around the badge), with a chevron just above it in its own room in the dock, and all of it opens the card. The card's actions (`ResultChoices`, `data-testid="result-choices"`) are handed to `details` for its place under the verdict: Loop (outside Repeat, for a run with rough bars: `lastResult.rough`, worded by `barsShortText`, "Loop 9–12"), then Again (outside Repeat or once the goal ended it). A Wait run's result (`lastResult.run`) has no time, streak or goal. A new Repeat result briefly shows more of its peek in a taller pill, then settles at the same width; the taller part is drawn above the pill's box (a cap and the summary slide down, the peek is clipped), so the dock and the review frame never change size. Tap or swipe up to grow from the pill to the original expanded card on a tablet or the full-screen details on a phone: the card is laid out once at its final size and `resultMotion.ts` draws the growth from the measured pill with transforms, clips and opacity only (Web Animations, `fill: backwards`); a fold plays the same animations backwards from where they are. A swipe's mouse click is swallowed only on the element the drag started on and only until the next task (a touch swipe sends none). Swipe down on the pill or the expanded phone header to hide the result and clear the marks and review zoom (U110). The details body scrolls independently. The pill fades and rises in, then fades and sinks out over `RESULT_FADE_MS`, showing the last result while it leaves. Details expands the pill in place (U99; nothing here leaves Practice): the `details` render prop (from `PracticeScreen`, `ResultDetailsLoader`) is rendered above the row as an absolute overlay up to the stage's top (or the screen's on a short screen), growing from the pill and folding back into it (`DETAILS_FOLD_MS`; when the next pass starts, a quick fold, `QUICK_FOLD_MS`); the expanded summary’s Details button, the phone header’s collapse control, Escape and the end of the result fold it, and each new result starts folded. While the next pass begins (U101) wrong keys change nothing; once it plays a correct note (`ui.resultDimmed`) the card folds and dims to the focus-mode strength (`data-dimmed`, `--practice-recede`), a tap or keyboard focus only brings it back to full strength (its controls take no input while dimmed), and played past (`ui.resultExit === 'played'`) it slides down out of the stage (or its own row upright, which clips it) over `RESULT_SLIDE_MS` at the strength it had. No saved-position banner (U57): reopening a piece silently restores its position. No end-of-piece banner: the footer's main button offers Start. |
| `ResultPeek.tsx` | What the pill shows of its card (U142). Not clean and with something to correct (`marked`): the first mistake's card, an empty shell at once, its caption and music (`drawPeek`, `PeekExcerpt` in `ResultDetails.tsx`) once drawn `PEEK_DELAY_MS` after the result, in an idle moment, while `idle` (nothing played, no count-in ending), with the module fetched then; else, or without one, the facts (`PeekFacts`), under the clean line when there are no marks. Never the pill's size. |
| `ResultDetailsLoader.tsx`, `ResultDetails.tsx`, `resultDetailsTypes.ts`, `resultDetails.module.css` | The expanded result card (U99). The loader fetches `ResultDetails` on the first expansion (it pulls in the excerpts and the scorecard and history panels, outside the practice path's bundle) and keeps the card's height while loading, showing the verdict and the actions; `ResultPeek` fetches it first, at rest. `ResultDetails` asks `session.resultDetails()` once per result (the mistakes ranked by `rankMistakes`) and shows the verdict, “No mistakes in this pass.” for a clean pass, the actions (`actions`, U142), and the places on the music (`render/excerpt` `planExcerpts` + `excerptMarkup`: one card per bar, with "Show N more bars" in reviews without timing corrections (with them every affected bar is listed, and a card's notation is mounted only while it is near the view, its placeholder keeping the height; the cards are memoized, so a session update re-renders only a card whose own props changed), the repeated kinds first under "Keeps happening", ghost notes from `pressGhost`, one `wrongPressLine` sentence per wrong key with "(three passes running)" / "(twice now)"), followed (after a clean pass preceded) by the “This pass” lines (`passFacts`) and the folded Results `ScorecardPanel` ("All the numbers for this pass") and `HistoryPanel` ("Earlier passes of this loop"; a row shows that pass's numbers in the card); a Wait run has neither, it is not stored (U142). Each excerpt has "What you played" and "As written" (U100: `session.playSnippet` / `stopSnippet` / `snippetBlocked`, the sounding one from `session.snippet`; folding the card stops it). Nothing in it navigates; a tap on an excerpt does nothing. |
| `reviewInset.ts` | `useReviewInset(dock, overlays, stripRef)`: a `ResizeObserver` on the result dock, the top overlay column and the score view's root hands the strip the height from the strip root's bottom to the dock's top and from the strip root's top to the overlays' bottom, each plus 8 px (`reviewInsetFor`, `reviewTopFor`, 0 without them) through `StripHandle.setReviewInset`, so the review after a pass (U97) keeps the card clear of the staves. Measured against the strip root (`reviewFrame`), which starts lower than the stage while the timing-cue row is on; the overlays move down with it, so that move changes nothing. A view created later is observed and measured through the handle's `attach()`. |
| `resultMotion.ts` | The result pill growing into its details and folding back (U110, U130, P4): keyframes from two measured rectangles (the pill before, the laid-out card after) that animate only `transform`, `clip-path` and `opacity`. Tablet: the panel rises from behind the summary row, the panel and the row are clipped from the pill's sides to the card's while a six-piece outline draws the edges the clips cut, the summary's ends slide out, the contents fade in. Phone: the full-screen panel starts at the pill's rectangle and fades in over it. `steerMotion` reverses from the current point (a quick second tap) and speeds up the fold when the next pass starts. |
| `CountIn.tsx` | The Keep time count-in (P13): `ui.countIn`, the beats left, as a large number in a translucent paper disc centered over the stage (`role="status"`, "Count-in: 3"; tokens only; a gentle pop per beat, none under `prefers-reduced-motion`). Inside the stage, under the banners, pointer events pass through; it never covers the footer's hand toggles or main button. |
| `OtherHandSheet.tsx` | "Where should the left hand sound?" (U149): what Start, Resume and Restart ask while `ui.otherHand` is set. `PracticeScreen` keeps the waiting start (`askedStart`) and holds input meanwhile; `env.testNotes` plays the test notes. |
| `TempoSheet.tsx` | Practice tempo entry when the score has none (saved as `PieceRecord.userTempo`). |
| `TimingBarPlot.tsx`, `timingReview.ts` | Timing feedback in completed Keep time Details (U108). Every bar with a miss or a deviation has one correction card, shared with any pitch corrections in that bar. The plot aligns to the notation and breaks at misses. The card has What you played and As written. An on-beat pass has a folded timing summary, shown only when scoring agrees (`TimingReviewData.scoredOff`: a chord that started on the beat but was completed outside the tolerance is scored late, so the summary does not claim every attack was near the beat). The plot's axis column is as wide as its longest label in the language shown (48 px at least). |
| `env.ts` | `PracticeEnv` seam (storage, MIDI, clock, timers, frames, prepare, createStrip, lazy loaders) and the production defaults. `primeAudio?()` creates or resumes the shared AudioContext inside the tap that turns the Metronome switch on (iPadOS starts one only during a gesture; production: `sharedAudioContext()` when Web Audio is supported, never throws). `PracticeStripOptions` = `StripOptions` (incl. `onCursorAction`, U14). `createStrip(host, layout, options, mode?)`: `'page'` mounts `PageView` (portrait), otherwise `StripView`; `StripHandle.cursorClientX?()` gives a moving cursor's x. `createMicFollower?` / `micSupported?` (P22): the microphone follower and whether this browser can open a microphone, for Follow; absent, the real ones (`app/audio/micFollower.ts`). |
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

**The header's room (U141, `modeFit.ts`).** The four modes sit centered (`data-modes="all"`): a grid of
two equal sides around them. The composer and the title shorten, then the connection chip, whose
words give way to its dot under `CHIP_WORDS_PX`. Where the title would fall under `TITLE_MIN_PX`, or a
take's controls or pill (`[data-recording-control]`, D20) would not fit in full, one `ModeButton`
replaces them after the title (`data-modes="one"`), and the rest is the tools'. The modes stay in the
DOM unseen to be measured, so the answer depends on nothing it changes. During a take the header goes
to the button at most once and stays with it until the take's controls are gone, so nothing moves
between opening, recording and the pill. While playing the control dims (`.recedes`) and is inert; a
touch there only brings it back (the click that follows is stopped). A phone has no header.

**Every portrait page (R17):** prepared with `pageMaxWidth` and shown with `fitWidth` on phones,
tablets and desktops alike, so the whole system is visible and the page never scrolls sideways.
Away from a phone a pinch or ctrl-wheel changes `view.pageZoom`, which re-prepares the page at
the width that zoom means (`pageWidthFor`).

**Phone-size screens (U80, `usePhone` / `usePhoneLandscape` from `views/shared`):** no header and
no footer. One 52 px top bar (`data-testid="practice-bar"`) holds Back, the title (upright) or
the overview in its place (on its side), the compact hand
toggles around Start / Pause and Menu. The mode (U141) needs no row and no button of its own upright:
the title block is one button (`ModeTitle`), the title with the mode and a chevron in the composer's
place; on its side a `ModeButton` sits between the overview and the hands. Both open `ModeSheet`. The
h1 is visually hidden. The menu is a `Sheet`
with Speed, the mode's rows, Metronome, Show keys (upright only), the connection chip
and Settings. Why Start is unavailable is a pill over the score (`StartReason`). In focus mode the whole bar
slides up, fades and its row collapses (U93: `.headerSlot` / `.headerClip`,
`data-testid="practice-bar-slot"`, inert while hidden), on its side
with the overview; any pointer press on the score brings it back without seeking (that tap's
`onSeekRequest` is dropped), as do pause, interruption, end and Tab. A tap while the bar shows
seeks as before. A phone on its side has no keyboard
guide at all. In portrait the page is engraved at zoom 1 and a pinch magnifies it like a photo
(`imageZoom`, U83). Everything below describes tablets and desktops.

Header and overview on one green ground, `.lid` (U154): (back, title / composer, the mode, connection chip, Settings) → overview
row (only the overview) → stage: score paper, full width, no box or shadow, down to the footer
(strip, top overlay column with the Repeat panel and banners, octave arrow) → keyboard-guide slot
(slides open and closed) → footer. The guide slot and the footer sit on the stage's `--score-paper`
with no line between (U155), so everything below the header is one surface by default. The guide and footer use `--practice-surface`, which follows the interface
theme even when the user pins the score paper to light. The red vignette is `WrongNoteFlash`,
which changes opacity only; the stage never shakes.
While playing (`data-recede="true"`) the header keeps its place, upright or on its side, and its
contents fade to 12 %, a take's controls excepted (U147); a tap on it only brings them back. The footer is one row on
every tablet, upright or on its side, and its tools dim in place (U66, U88). Only a window 640 px
wide or less wraps the tools into a row above the hand cluster, and in portrait that row slides
down and collapses so the score gains height without re-engraving or replacing its view. Hidden
rows are inert.
Hand toggles and the Repeat panel retain their 12 % fade. The overview, feedback (flash, octave
arrow, banners), and main playback button stay visible. Pause, a touch on the stage, a pointer
near the cursor or controls, or keyboard navigation restores the chrome. Keyboard focus and an
open Speed dialog keep it available. Speed's upward popover is not clipped when the row is open.
Restart loop sits at the bottom start edge of the stage (in the result dock in landscape). It
moves up above the result pill wherever the pill leaves it no room beside it (`data-stack` on the
dock, measured, P11; always in a window 720 px wide or less), and in a window 640 px wide or less
above Return to current position while that shows.
The footer menu's last actions (Progress, Record performance) have the rows' spacing above and below them
and a hairline above them, full width with their icon and label at the start
(`FooterMenu.module.css`).

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
  empty state, timed reading + octave arrow, preset → Repeat mode + scored result,
  a repeated mistake on the result pill after three passes (reworded live on a naming change),
  Labels control, Repeat panel only in Repeat mode (not in the overview row),
  browsed bar, no passage bar / Settings in the header / Speed and Labels in the footer, the
  cursor repeat button, receding chrome, remembered passage, the speed ladder select (goals,
  status line, saved on the piece).
  The Metronome switch (off by default, edits `metronome.enabled` and primes audio once, the Keep time
  preference in Keep time, disabled without Web Audio, the phone sheet's row).
  `PracticeView.modes.test.tsx` (U141, the rules Sheet music had included): the header control, the
  hands, the missing piano in each mode, opening, what Listen and Follow keep out of practice, the
  menu's rows, the phone's title and mode button, and translation coverage per mode. Both use
  `viewTestkit.ts`. `modeFit.test.ts`: the header's arithmetic.
  `RepeatPanel.test.ts`: ladder goals and status text.
- `tests/e2e/practice-review.spec.ts` (U97): a five-bar loop of a generated score completed at
  1194×834 zooms out to show the whole loop, the result covers none of its notes or marks, the
  first notes of the next pass are matched at once and the zoom comes back exactly; Hide ends
  the review and the saved zoom is untouched; the same wrong key three passes running puts "D♭
  instead of D♮ in bar 1, three passes running" on the pill (P24). `LOOP_REVIEW_SHOTS=<dir>`
  saves mid-review and settled screenshots at 1194×834, 834×1194, 390×844 and 852×360, light and
  dark, and the pill with that line at 1194×834 and 390×844.
- `tests/e2e/practice-run.spec.ts` (U142): a whole-piece Wait run shows the pill and stores no attempt;
  the pill's peek is cut off, drawn at rest without changing its height, fetched only then, with no
  button but the pill's own control and ✕, after a run and a loop; the card's actions under its
  verdict; Loop and Again, also opened over Keep time's tail; the
  next run plays past the pill; a rotation. `RUN_SHOTS=<dir>` saves screenshots.
- `ResultPeek.test.tsx` (happy-dom): drawn at rest only, canceled by playing, the facts as fallback.
- `FooterMenu.test.tsx` (happy-dom, `PracticeMenuItems` with a stub): Metronome state and
  description, the rows of each mode, and Follow's input.
- `tests/e2e/practice-modes.spec.ts` (U141): every mode on a tablet and a phone both ways, focus mode,
  no piano, one hand in Listen, Follow over MIDI, the Library's line, old study links, a phone without
  Web MIDI, and the header's fit by bounding boxes at 1194, 834 and 744 px in five languages.
  `recordings.spec.ts` measures the same header with a take and its pill.
- `tests/e2e/practice-metronome.spec.ts`: the switch's states per preference, and real clicks counted
  through `AudioContext.createOscillator` (Keep time clicks past the count-in; off leaves only the
  count-in's four; ordinary reading with it off makes none), and Listen's switch while it plays.
- `Banners.test.tsx` (happy-dom, `Banners` and `GuidePanel` with stub session stores): one
  disconnect notice at a time, no end-of-piece banner, the result card's fade in / out (Hide
  works, the last result stays while leaving, no time / first try / help facts), the headline
  and badge (`resultTitle`), the goal dots, the note line (worded from `repeatedMistakes`, letters and fixed do),
  the pill's two controls and the card's actions (U142), the ladder line, the Keep time timing line (`timingText`) and no Ready banner in Keep time, the `CountIn` display, the guide slot's
  `data-open`.
- `tests/e2e/practice.spec.ts`, `practice-assist.spec.ts` (production build, injected fake Web
  MIDI, IndexedDB seeded with `two-hands.musicxml`; `loopWholePiece` helper): wrong-note flash
  + octave arrows, scored completion, result card, dark theme, portrait, MIDI-only practice never fetches
  `/samples/`, hints, labels, the 88-key guide live before Start, Repeat readiness, Results,
  Listen on MIDI, Listen without a piano through browser sound (Auto).
- `tests/e2e/practice-cursor.spec.ts`: first and resumed Listen sound the exact onset browsed
  backward to, notation follows, reading accepts that onset, and keyboard seeking starts
  from the visible note. `practice-page.spec.ts` also checks resumed following after scrolling.

## The expanded result by screen size (U99, 17 November 2026)

`AttemptResult` (`Banners.tsx`, prop `phone` from `usePhone`) expands the pill into one of two layouts
(`data-layout` on `[data-testid="result-details"]`; the dock and the pill never change height, so
the review frame and the strip's transform are untouched by expanding):

- **Phone (`screen`):** the details section is `position: fixed; inset: 0` (the whole viewport,
  over the top bar and footer), no border or radius, `role="dialog"` `aria-modal="true"`. Its own
  sticky header (`result-screen-header`): the chevron down (`result-details-hide`, "Hide details",
  focused on opening), the verdict headline with the goal dots, Hide result; 60 px upright,
  48 px on its side, padded by the safe-area insets. Content: 760 px at most, centered, safe-area
  padding, excerpts up to twice their size. The pill underneath is `inert`; focus returns to its
  chevron on close; Tab wraps inside (`wrapTab`); Escape folds it. It grows from the pill (moved
  to the pill's top and clipped to its rectangle, fading in over it); without a pill to start from
  it slides up 32 px while fading; reduced motion keeps only the short fade.
- **Tablet (`panel`):** a labeled region above the pill, up to 900 × 880 px, 16 px margin to the
  stage's top and sides and to the footer (the dock and the page-mode result row keep 16 px),
  24 px padding, excerpts up to 1.4 times their size and 720 px wide, centered.

`tests/e2e/practice-result-details.spec.ts` checks both at 390×844, 852×360, 1194×834 and 834×1194
(box equal to the viewport, covering the top bar and footer, the chevron reachable; the panel's
margins; the strip's transform unchanged across expand and collapse; rotation keeps it open).
`RESULT_DETAILS_SHOTS=<dir>` saves collapsed and expanded screenshots at those sizes, light and dark.

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
practice or Listen (P10); Settings still pauses and isolates input.
