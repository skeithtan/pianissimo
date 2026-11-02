# core/naming — note names, accidentals, simplification, label eligibility

Framework-independent (no DOM, no Preact). Turns an already-resolved performed note into label
text and decides which notes carry a persistent label. It never changes the pitch, MIDI
matching, scoring, highlighted keys or printed notation (spec "Mistake feedback and hints":
"These naming settings leave … unchanged"). Consumers: the notation renderer (persistent and
temporary labels), the keyboard guide (chip names, octave landmarks), the Settings view
(thresholds, live sample) and the engine (hint text).

## Public API (`index.ts`)

| Area | Exports |
| --- | --- |
| Label text | `labelFor(note, naming)` → `{ name, accidental, octave, text }`; `labelText`; `labelForMidi(midi, naming, prefer?)` for a bare key (landmarks); `stepName`; `maxLabelWidthChars(naming)` for reserving label room |
| Glyphs | `SHARP`, `FLAT`, `NATURAL`, `DOUBLE_SHARP`, `DOUBLE_FLAT`, `accidentalGlyph(alter)` |
| Spelling | `simplifySpelling`, `spellMidi`, `midiOctave`; `parseSpelling(text)` and `formatSpelling` for typed thresholds ("C4", "B♭3", "do#4", "Cx4") |
| Context | `keySignatureAlter(step, fifths)`, `contextAlter(context, step, writtenOctave)` |
| Eligibility | `isPersistentLabelVisible(note, labels)`, `ruleLabelsMidi(rule, midi)`, `ruleForClef(labels, clef)` |
| Rule editing | `validateRule`, `thresholdProblem`, `describeRule` (plain-language summary), `sampleRule` (live sample of labeled/unlabeled pitches) |
| Clefs | `parseClefKey`, `clefShortName` ("Treble", "Bass 8vb"), `clefDisplayName` ("Treble (G)") |

`labelFor` takes `Pick<PerformedNote, 'sounding' | 'ottavaShift' | 'accidentalContext'>` and
`NamingSettings` (`system` letter or fixed-do, `seventh` si or ti, `showOctave`,
`alwaysShowEffectiveAccidentals`, `simplifyEnharmonics`). Eligibility takes only the sounding
`midi`, the governing `clef` key and `tieContinuation` plus `PersistentLabelSettings`.

## Design notes

- **Pitch first.** Labels derive from the resolved sounding pitch and the retained source
  spelling, never from the printed accidental. Ottava is applied exactly once: written C4 under
  8va is labeled C5; `ottavaShift` is used only to find the written staff position that key
  signature and carried accidentals are keyed by (written octave = sounding − shift, D-M1).
- **Order of operations.** Simplify the spelling first (B♯4 → C5, C♭4 → B3, E♯→F, F♭→E, double
  accidentals to natural or a single accidental in the original direction; E♭ and C♯ stay),
  recalculating the octave, then decide accidental display, then convert to fixed do
  (C♯ → do♯, simplified B♯ → do in the correct octave). Middle C is C4 / do4.
- **Effective accidentals ON (default).** Name the actual pitch as if read without a key
  signature: a key-signature C♯ is "C♯4". A natural that cancels an implied alteration shows ♮.
- **Effective accidentals OFF.** Omit an accidental the key and measure context already imply;
  changes and cancellations stay visible, also after respelling (B♯4 in C♯ major with
  simplification is "C♮5"). The two preferences are independent.
- **Eligibility is pitch-only.** Strict comparisons on sounding MIDI (`< below`, `> above`),
  enabled conditions combined with OR, evaluated per note against the rule of the clef governing
  its displayed staff. Tie continuations (held, not played) qualify only with
  `tiedContinuations` on, which is off by default in both modes (DECISIONS U69). Enharmonic spellings, naming language, hand assignment and printed
  accidentals cannot change it. A clef with no stored rule gets a both-disabled rule; bass is
  never initialized from treble.
- **Validation.** An enabled condition needs a valid pitch (note name, accidental up to two,
  whole octave, within MIDI 0–127) and, with both enabled, "below" must not be above "above".
  Equal boundaries are allowed; both off is valid and labels nothing.

## Spec coverage

Done (unit-tested, 172 tests in 7 files): letter names and fixed do with si/ti; effective
accidentals on and off; enharmonic simplification table and its contextual variant (`C♮5`);
octave display preference; ottava handling; all four preference combinations; persistent label
modes Off / All notes / Conditional; per-clef rules with strict boundaries (B3 and C♯5 labeled,
C4 / E4 / C5 not); sounding-pitch comparison (written C5 under 8va qualifies for "above C5");
threshold parsing, validation messages, plain-language summary and live sample; label-width
reservation helper.

Not here by design: placing labels beside noteheads and reserving layout space (render/),
fading and expiry timers (engine/ hint state and the renderer), recording label exposure as
assistance (engine/history), persisting settings (storage/). Movable do is a separate future
feature (key-dependent interpretation) and is not implemented.
