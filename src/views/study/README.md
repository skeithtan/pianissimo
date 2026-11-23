# views/study — Sheet music (DECISIONS U72, U105, U106)

Lazily loaded from `app/views.ts` (`chrome: 'none'`, route `#/study/<pieceId>`). Open a piece to
read the score, listen to its playback or follow your playing without grades or practice records.
The user asked for it on 3 November 2026: "a piece consultation mode, compatible with iPhone, not for practice, just
playback and seeing the notes, hints possible too".

## What it offers

- **Listen** plays the whole piece (pause, resume, Speed) through the piano when
  one is connected, else this device's browser sound (S3, S4). Seeking: the overview bar, a tap
  or drag on the score, the dragged playhead. Browsing the score while it plays pauses it (U41).
- **Follow my playing** moves the cursor with the learner's live playing (P12, U105). The Sheet music
  menu selects piano or microphone when available and the hands to follow. Listen and following
  share the cursor and stop each other. A following microphone mutes the click and accompaniment.
  With a MIDI piano, Rushing or Dragging appears above the playhead when recognized notes
  come substantially faster or slower than the written pace at the selected speed (U111).
- **The score** as in Practice: the strip in landscape, the page in portrait (same `StripView` /
  `PageView`, same cached layouts, same zoom settings). No loop handles, no cursor repeat button
  (`SessionOptions.cursorAction: false`), no corrections. Follow marks the current notes.
- **Reading aids**: Note names (Off / Conditional / All), Show keys (the 88-key guide), and a
  **Metronome** switch. The score overview handles seeking, including back to the first bar.
- **The footer is Practice's** on tablets and desktops (U90): `FooterBar` from
  `practice/Footer.tsx` with Speed at the start edge and Listen and Follow my playing centered;
  `FooterMenuPopover` from `practice/FooterMenu.tsx` at the end edge, a Menu button whose
  "Sheet music menu" popover holds Note names, following options, Metronome and Show keys. It stays
  open while the piece plays. Transport status appears under the center cluster.
- **Settings** over the score, Back to the Library.

## Files

| File | Role |
| --- | --- |
| `StudyView.tsx` | Entry. Reads `studyRequest`; loads piece + package; missing piece → explanation + Back to Library; no request → empty state with Back to Library and recent pieces. `StudyViewWith({env})` for tests (the Practice `PracticeEnv` seam is reused). Opening a piece updates `lastOpenedAt` only. |
| `StudyScreen.tsx` | Builds a `PracticeSession` initially in Listen (`hands: 'none'`, no range, speed 1, `cursorAction: false`) with a no-op history sink and a no-op piece sink, so the piece's practice state (hands, speed, loop, resume) is never read or written. Prepares the layout exactly as Practice does (label width, label room with the respacing glide, rotation, page width), without the prepare-ahead. Header (Back, title / composer, Settings), `OverviewBar`, stage, `GuidePanel`, footer (Practice's `FooterBar` and `FooterMenuPopover`, U90; `LABEL_OPTIONS` from `practice/FooterMenu`). |
| `study.module.css` | Tokens only. Header / overview / stage / keyboard guide; the footer's layout is Practice's (`practice.module.css`, U90), and this file styles its transport group. `data-compact` (phone-size): no footer, a header with 44 px transport actions and Menu, the menu sheet's rows, the status pill over the score, and the home-indicator strip. Nothing recedes. |
| `../shared/usePhone.ts` | `usePhone()` / `PHONE_QUERY`: at most 520 px wide, or landscape and at most 520 px tall (U74); `usePhoneLandscape()` / `PHONE_LANDSCAPE_QUERY`: the landscape half alone (U80). Shared with Practice (its phone layout, U80) and `GuidePanel`, which drops the keyboard guide's name chips on a phone (U75) and the guide itself on a phone on its side (U80). |

Shared with Practice: `practice/env` (`PracticeEnv`, `StripHandle`), `practice/live`
(`OverviewBar`, `GuidePanel`), `practice/ScoreSkeleton`, `practice/TempoSheet`,
`practice/useOrientation`, `practice/useStore`, `labelRoom` from `practice/PracticeScreen`,
`FooterBar` (`practice/Footer`), `FooterMenuPopover`, `footerMenuClasses` and `LABEL_OPTIONS`
(`practice/FooterMenu`) and the `startReason` class of `practice.module.css`.

## Phone layout (U74, U80)

The phone header holds Back, the title, Listen, Follow my playing and Menu. The menu sheet
holds Speed, Note names, following options, Metronome, Show keys when available, and Settings. Transport status appears over the score. Tablets and larger
keep the footer (Practice's, U90) and the Settings button in the header.

A phone on its side (`usePhoneLandscape`, U80) puts the overview in the header in the title's
place (the title stays as a visually hidden h1), drops Show keys and has no keyboard guide, so
the strip gets the height. In portrait, on every device, the page is prepared with
`pageMaxWidth` and shown with `fitWidth` (R17): the whole system is visible and the page never
scrolls sideways.

## iPhone notes

Safari on iPhone has no Web MIDI, so the Library shows the capability banner and the Study
view plays through browser sound (the Salamander samples load on the first Play, a user
gesture). `viewport-fit=cover` plus the `--safe-*` tokens keep the footer above the home
indicator. The portrait page engraves systems for the stage width (`pageWidthFor`, minimum
240 layout px) at `view.pageZoom`; pinch zoom changes the page width and re-prepares, and the
page stays fitted to the stage (R17). On a phone
held upright the page is engraved at zoom 1, and a pinch magnifies it like a
photo instead, without re-preparing or saving anything (U83). The screen
stays awake while the view is shown (`app/App.tsx` wake lock), as in Practice.

## Tests

- `StudyView.test.tsx` (happy-dom, fake-indexeddb, an imported fixture, fake MIDI/strip, no
  Web MIDI): empty and missing states, the controls offered and withheld, playback and pause
  with no practice state written, overview seeking, the Note names respacing glide, the tablet
  footer with Listen and Follow my playing, and its menu
  (exactly Note names, Metronome, Show keys; stays open while playing; Escape closes it), the
  Show keys and Metronome switches and the phone sheet's switch, Settings and Back.
- `app/session/PracticeSession.reveal.test.ts`: `revealAtCursor` and `cursorAction`.
- `tests/e2e/study.spec.ts` (Chromium + WebKit, production build, phone viewports 390×844
  and 844×390 with touch, no fake Web MIDI): the route, the page view in portrait, browser-sound
  playback, no footer with the header controls ≥ 44 px and the stage taking the height, the
  menu (Note names and Settings), Show keys reaching the bottom of the
  screen, nothing recorded, reload and Back, the strip in landscape; and a tablet viewport
  with Practice's one-row footer, its Sheet music menu (Note names, Metronome, Show keys) and
  Settings in the header (U90).

## Known gaps

- Not yet checked on a real iPhone (🔒); the layout is verified at phone viewports in
  Playwright only.
- No listening filter for one hand (the spec keeps it optional); the parts both sound.
