# views/study — Study view (DECISIONS U72)

Lazily loaded from `app/views.ts` (`chrome: 'none'`, route `#/study/<pieceId>`). The Practice
view's reading-only sibling: open a piece to listen to it and read it, on any device with a
browser, a phone included. Nothing is practiced, graded or recorded. The user asked for it on
3 November 2026: "a piece consultation mode, compatible with iPhone, not for practice, just
playback and seeing the notes, hints possible too".

## What it offers

- **Playback** of the whole piece (Play / Pause, Go to the start, Speed) through the piano when
  one is connected, else this device's browser sound (S3, S4). Seeking: the overview bar, a tap
  or drag on the score, the dragged playhead. Browsing the score while it plays pauses it (U41).
- **The score** as in Practice: the strip in landscape, the page in portrait (same `StripView` /
  `PageView`, same cached layouts, same zoom settings). No loop handles, no cursor repeat button
  (`SessionOptions.cursorAction: false`), no targets, no corrections.
- **Reading aids**: Note names (Off / Conditional / All, the persistent labels, same settings as
  Practice), **Name the notes at the cursor** (`session.revealAtCursor()`: the names of both
  hands' notes at the cursor for the hint lifetime, then a fade; the engine's own hints need a
  running attempt, which Study never has), and Show keys (the 88-key guide, which follows
  playback here).
- **Settings** over the score, Back to the Library.

## Files

| File | Role |
| --- | --- |
| `StudyView.tsx` | Entry. Reads `studyRequest`; loads piece + package; missing piece → explanation + Back to Library; no request → empty state with Back to Library and recent pieces. `StudyViewWith({env})` for tests (the Practice `PracticeEnv` seam is reused). Opening a piece updates `lastOpenedAt` only. |
| `StudyScreen.tsx` | Builds a `PracticeSession` in Listen (`hands: 'none'`, no range, speed 1, `cursorAction: false`) with a no-op history sink and a no-op piece sink, so the piece's practice state (hands, speed, loop, resume) is never read or written. Prepares the layout exactly as Practice does (label width, label room with the respacing glide, rotation, page width), without the prepare-ahead. Header (Back, title / composer, Settings), `OverviewBar`, stage, `GuidePanel`, footer. |
| `study.module.css` | Tokens only. Header / overview / stage / keyboard guide / footer; the footer stacks the reading aids (Note names, Hint, Keys) over the transport row (Speed, Go to the start, Play). `data-compact` (phone-size): no footer, a 48 px header with Show keys, a 44 px Play and Menu, the menu sheet's rows, the status pill over the score, and the home-indicator strip. Nothing recedes. |
| `../shared/usePhone.ts` | `usePhone()` / `PHONE_QUERY`: at most 520 px wide, or landscape and at most 520 px tall (U74); `usePhoneLandscape()` / `PHONE_LANDSCAPE_QUERY`: the landscape half alone (U80). Shared with Practice (its phone layout, U80) and `GuidePanel`, which drops the keyboard guide's name chips on a phone (U75) and the guide itself on a phone on its side (U80). |

Shared with Practice: `practice/env` (`PracticeEnv`, `StripHandle`), `practice/live`
(`OverviewBar`, `GuidePanel`), `practice/ScoreSkeleton`, `practice/TempoSheet`,
`practice/useOrientation`, `practice/useStore`, `labelRoom` from `practice/PracticeScreen`.

## Phone layout (U74, U80)

On a phone-size screen there is no footer. The header holds Back, the title, Show keys, Play /
Pause and Menu; the `Sheet` titled "Menu" holds Speed, Note names, Name the notes at the
cursor, Go to the start and Settings. The hint and Go to the start close the menu. Why Play is
unavailable, or the sound status, is a pill over the bottom of the score. Tablets and larger
keep the footer and the Settings button in the header.

A phone on its side (`usePhoneLandscape`, U80) puts the overview in the header in the title's
place (the title stays as a visually hidden h1), drops Show keys and has no keyboard guide, so
the strip gets the height. In portrait the page is prepared with `pageMaxWidth` and shown with
`fitWidth` (R17): it never scrolls sideways.

## iPhone notes

Safari on iPhone has no Web MIDI, so the Library shows the capability banner and the Study
view plays through browser sound (the Salamander samples load on the first Play, a user
gesture). `viewport-fit=cover` plus the `--safe-*` tokens keep the footer above the home
indicator. The portrait page engraves systems for the stage width (`pageWidthFor`, minimum
240 layout px) at `view.pageZoom`; pinch zoom changes the page width and re-prepares. The screen
stays awake while the view is shown (`app/App.tsx` wake lock), as in Practice.

## Tests

- `StudyView.test.tsx` (happy-dom, fake-indexeddb, an imported fixture, fake MIDI/strip, no
  Web MIDI): empty and missing states, the controls offered and withheld, playback and pause
  with no practice state written, the Hint tool, the Note names respacing glide, Show keys,
  Settings and Back.
- `app/session/PracticeSession.reveal.test.ts`: `revealAtCursor` and `cursorAction`.
- `tests/e2e/study.spec.ts` (Chromium + WebKit, production build, phone viewports 390×844
  and 844×390 with touch, no fake Web MIDI): the route, the page view in portrait, browser-sound
  playback, no footer with the header controls ≥ 44 px and the stage taking the height, the
  menu (hint, Note names, Go to the start, Settings), Show keys reaching the bottom of the
  screen, nothing recorded, reload and Back, the strip in landscape; and a tablet viewport
  keeping the footer with no menu.

## Known gaps

- Not yet checked on a real iPhone (🔒); the layout is verified at phone viewports in
  Playwright only.
- No listening filter for one hand (the spec keeps it optional); the parts both sound.
