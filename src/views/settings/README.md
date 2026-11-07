# src/views/settings — Settings overlay

`SettingsOverlay` is a full-height `Sheet` over the current view (the view stays mounted, so the
selected score and passage are never lost). Mounted once by `app/App.tsx`; open it with
`openSettings()`. Escape and the close button dismiss it, focus moves in and returns to the
opener, and it fades in and out. Eight tabs; every panel stays mounted (hidden when inactive) so
typed text and staged label edits survive switching tabs. Landscape: tab list on the left;
portrait: a scrolling strip on top.

| Tab | Content | Applies |
| --- | --- | --- |
| Note names | Letter / fixed do, si / ti, octave, *Always show effective accidentals* (default on), *Simplify enharmonic names* (default off); live examples (B♯4 in C♯ major, C♯4 in D major, F𝄪4, B♭4 in F major) computed with `core/naming` | immediately |
| Score labels | Off / All notes / Conditional; per-clef rules (G and F first, then any other clef key in settings): Show below / Show above toggles, threshold pitch inputs, strict wording, validation, plain-language summary, live sample, treble preset | on **Apply** |
| Hints | Automatic threshold 1 / 2 / 3 / custom positive integer / off; lifetime 10 / 20 / 30 / 60 s / custom / Until correct; fade duration (100–1000 ms, default 300); red flash; a **Keep time** group (`KeepTimeGroup.tsx`, P13): the timing window Tight ±80 ms / Normal ±150 ms (default) / Loose ±250 ms with one line of explanation (a stored non-preset value shows "Now ±N ms." with no choice selected) | immediately (a new Keep time window stops a Keep time attempt in progress, like a label change) |
| Pedal | Hint pedal action (note names / Show keys); summary of the learned mapping; *Set up in Connection* closes Settings and navigates | immediately |
| Sound | Destination: Connected piano (MIDI, default) / Browser sound (explicit); browser volume; accompaniment level; metronome on/off + volume; optional input monitoring | immediately |
| General | Suggestions toggle; theme System / Light / Dark; score paper | immediately |
| Backup | Export backup (download), Restore from backup (confirm, then the merge report or why the file is not a backup, in place), storage status line. Uses its own `LibraryModel` and `LibraryDeps` from `views/library` (DECISIONS L7) | on Restore |
| About | Version, MusicXML-only import, data stays on this device, Salamander credit with CC-BY 3.0 link, this browser's capabilities | — |

## Staged label settings (spec "Persistent score labels")

Mode, rule and tied-note (U69) edits are held in `labelDraft` (module signal in `labelDraft.ts`). Nothing reaches
`settings` until **Apply**, which calls `applyLabelSettings`, which runs the
`onBeforeApplyLabels` hook (the practice session interrupts a scored attempt) and then updates
settings. Apply is disabled while there is nothing to apply or while anything blocks it:

- text that is not a pitch (`parseSpelling` message: not a note name, octave missing, outside the
  MIDI range, …),
- an enabled condition without a pitch,
- both conditions enabled with Show below higher than Show above (`validateRule` message).

Rules only matter in Conditional mode, and a disabled condition is never validated. Strict
comparisons are spelled out under each pitch ("Notes lower than C4 are labeled; C4 itself is
not."). The live sample (`sampleRule`) and the summary (`describeRule`) update while typing,
before applying. The treble preset button appears only for the G clef when its rule differs from
the preset; bass stays unset until the learner chooses it and treble thresholds are never copied.
Closing with unapplied label edits discards them and shows a toast; the tab shows a dot while edits
are pending.

The Apply row aligns with the settings cards without its own border or corner rounding. Its
opaque background stays sticky at the bottom while long conditional rules scroll behind it,
and the status and buttons wrap at narrow widths (U54).

## Files

`SettingsOverlay.tsx` (sheet, tabs, close handling), `LabelsSection.tsx`, `RuleEditor.tsx`,
`PitchInput.tsx`, `labelDraft.ts`, `NamingSection.tsx` + `namingExamples.ts`, `HintsSection.tsx` +
`numbers.ts` + `KeepTimeGroup.tsx`, `PedalSection.tsx` + `pedalSummary.ts`, `SoundSection.tsx`, `GeneralSection.tsx`,
`AboutSection.tsx`, `parts.tsx` (layout), `settings.module.css`, `testkit.tsx` (test helpers).

## Decisions and open points

- **Pitch entry is a text field plus a button picker.** The field (`C4`, `F#3`, `Bb5`, `do#4`,
  `C𝄪4` all parse; the octave is required) is quick with a keyboard and `parseSpelling` errors
  are specific. The "♭ ♯" button beside it (`Choose … with buttons`, `aria-expanded`) opens an
  inline picker that needs no keyboard (on an iPad ♯ and the digits sit on other keyboard
  layers): Note C–B and Accidental ♭ ♮ ♯ (radio groups), Octave − / + (0–8). It edits the pitch
  in the field (from middle C when the field is empty or invalid) and follows typed text; double
  sharps and flats stay text-only. Pure step: `pickSpelling`.
- **Custom from Off** (hint threshold) starts at 4 wrong attacks, and **custom from Until
  correct** (lifetime) at 45 s, so the custom field always has a valid starting value.
- **Fade duration** is limited to 100–1000 ms in the UI (the spec requires a smooth fade, not an
  instant one). The engine clamps it to the hint lifetime.
- **Input monitoring** (`sound.monitorInput`, default off) is exposed under Sound because the
  setting exists in the contract; the playback module must implement it or the toggle should go.
- **Browser-sound download** is described as "about 2 MB" (30 MP3s, DECISIONS S1).

## Tests

`SettingsOverlay.test.tsx` (open/close/Escape/focus/tabs/discard notice), `LabelsSection.test.tsx`
(validation, staged apply and hook order, summary, sample, strict wording, preset, other clefs),
`Sections.test.tsx` (naming examples change with every switch, hints, Keep time window, pedal,
sound, general, about), `BackupSection.test.tsx` (export download, in-place restore with merge report, invalid file),
`helpers.test.ts`. Run: `npx vitest run src/views/settings`.
