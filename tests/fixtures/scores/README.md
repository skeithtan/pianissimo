# Score fixtures

Hand-written MusicXML used by importer, renderer and e2e tests. Each file's header comment states
what it exercises. `.mxl` archives are built in tests with fflate; long scores come from
`../generate-long-score.ts` (`generateLongScore(500)`).

| File | Exercises |
| --- | --- |
| `two-hands.musicxml` | simultaneous hands, block chord, ♩ = 60, mf |
| `unequal-rhythms.musicxml` | eighths vs dotted left hand, a second voice after `<backup>` |
| `ties.musicxml` | three-note tie chain across a bar, one tied chord member |
| `pickup.musicxml` | implicit pickup bar "0" in 3/4, short final bar, G major |
| `tuplets.musicxml` | triplet eighths, quintuplet sixteenths (divisions 30) |
| `tempo-changes.musicxml` | ♩ = 120 → 90, 6/8 at ♩. = 60, sound-only tempo keeping the dotted unit |
| `tempo-conflict.musicxml` | printed ♩. = 60 vs sound tempo 60 (reported) |
| `no-tempo.musicxml` | verbal tempo only, unnumbered rolls on each staff |
| `timing-marks.musicxml` | unrealized rit., fermata, "a tempo"; realized rall. |
| `repeats.musicxml` | `|: :|` with first/second endings, clef change in ending 1, ties into endings |
| `repeat-ottava.musicxml` | 8va crossing a repeat (split performed spans), single staff |
| `ottava.musicxml` | 8va (written C4 → C5), 15ma, 8vb, 15mb, tie leaving a bracket |
| `rolls.musicxml` | cross-staff shared roll, independent rolls, shortened roll, single-note roll, shared pitch, explicit attacks |
| `csharp-major.musicxml` | 7 sharps, B♯4, carried naturals |
| `two-parts.musicxml` | voice + piano as two one-staff parts, brace, tempo only in the voice part |
| `unsupported.musicxml` | grace note, trill, tremolo, quarter-tone |
| `shared-pitch.musicxml` | the same pitch in two voices at one onset |
| `cross-staff.musicxml` | a voice crossing staves (left hand kept, `hand-cross-staff` note, no confirmation) |
| `split-voice.musicxml` | a voice genuinely split between the staves (hand confirmation required) |
| `changes.musicxml` | key, meter, mid-bar clef change, pedals, dynamics, fingering |
| `dc-al-fine.musicxml` | D.C. al Fine via `<sound dacapo/fine>` (followed: 1 2 3 1 2) |
| `dc-repeats.musicxml` | D.C. al Fine as words only, with repeats and endings not retaken after the jump |
| `ds-al-coda.musicxml` | D.S. al Coda with tokens, an 8va split at the To Coda jump, key context after the jump |
| `timewise.musicxml` | score-timewise input |
| `malformed.musicxml`, `unrelated.xml` | readable rejections |
