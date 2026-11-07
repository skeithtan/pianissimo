# Pianissimo

Pianissimo teaches piano notation reading with a connected MIDI piano. Import a MusicXML score,
read it on a scrolling staff, and the app grades what you play: hints appear after a mistake,
passages loop until they are clean, and after each attempt a teacher's red-pen corrections show
what to improve. It is a static web app (no server, nothing leaves your device) with full touch
screen support.

Live: <https://skeithtan.github.io/pianissimo/>

## Features

- MusicXML import (`.musicxml`, `.xml`, compressed `.mxl`) with repeats, D.C./D.S., ottavas,
  rolled chords, ties and cue notes handled; hands assigned from the score.
- Practice with a MIDI piano: both hands, or one hand while the app plays the other in time
  with your presses; a continuous musical transport with a gate at every note.
- Note-name hints (letters or fixed do) after one mistake, persistent labels by rule, an
  88-key keyboard guide, octave and accidental cues at the cursor.
- Repeat mode: whole-bar loops from the overview or note-level loops on the staff, consecutive
  clean-pass targets, lead-ins from anywhere in the piece.
- Keep time: a count-in, then the music runs at tempo × Speed and never waits; every note is
  judged against its beat, late notes are missed, and the scorecard reports timing accuracy.
- Speed ladder: in Repeat mode the app raises Speed one step each time the clean-pass target is
  met and drops it back after repeated failures, up to the goal you set.
- Teacher corrections after an attempt: wrong notes, wrong accidental or octave, too soon or
  too late, notes not played together, re-attacked tie ends, pedal.
- Consult mode: listen to a piece and read its score on any device, a phone included, with
  note names on request and no practice involved.
- Listen mode, practice history and suggested passages, backup and restore, light and dark
  themes, a portrait page layout and a landscape strip.

## Requirements

A browser with Web MIDI: desktop Chrome, or the MIDIWeb Browser on iPad. Safari can view and
listen without a piano.

## Development

```bash
npm install
npm run dev          # Vite dev server
npm test             # Vitest unit tests
npm run typecheck    # strict tsc
npm run build        # production build for /pianissimo/
npm run test:e2e     # Playwright (Chromium + WebKit)
```

Documentation: [docs/SPECIFICATION.md](docs/SPECIFICATION.md) (product specification) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module map and contracts).

## Hosting

`main` deploys to GitHub Pages through `.github/workflows/pages.yml`; `ci.yml` runs the format
check, typecheck, unit tests, build and Playwright on every push and pull request.
