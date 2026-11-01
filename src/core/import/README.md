# core/import — MusicXML importer

Turns a picked file (.musicxml, .mxl, MusicXML .xml) into the common `ScoreModel`, the
engraver's unfolded `renderXml`, an import summary and the retained source record. Worker-safe:
no DOM (typechecked with WebWorker libs only); runs in the import worker or directly in Node/tests.

## Public API (`index.ts`)

| Entry point | Purpose |
| --- | --- |
| `createImportClient(opts?)` | Main-thread client: `inspect(file, {signal, onProgress})`, `build({candidate, partIds}, opts)`, `dispose()`. One job at a time (a new job cancels the running one); abort → worker terminated, the promise rejects once with `ImportError` code `canceled`, no later progress/result. Keeps the last inspected file so `build` can follow (and be repeated with other parts). The worker is terminated after each build. `opts.createWorker` injects a fake for tests. |
| `inspectSource(file, opts?)` | Pure: detect format, open document(s), list `ImportCandidate`s (scores/movements → parts with id, name, staves, note count, `pianoLike`, `suggestedParts`) + diagnostics. |
| `buildScorePackage(file, selection, opts?)` | Pure: `{ package: {model, renderXml}, summary, source }`. Options: `limits`, `signal`, `onProgress(stage, fraction)`, `now`. |
| `applyHandAssignment(model, byVoice)` | Apply user-confirmed hands per voice (`"P1:5": 'L'`); re-hands notes, sets `hands.confirmed`. Throws on unknown voices/hands. |
| `withUserTempo(model, beatBpm, beatUnit)` | Practice tempo for scores without one: single `user` segment + roll realization. |
| `summarizeImport(model)` | `ImportSummary`: counts (chords, ties, tuplets, grace, cue…), voices + hands, ottavas, rolls, repeats, tempo (incl. conflicts), changes, unsupported regions, timing issues, diagnostics, readiness (tempo, hands, blockers). |
| `ImportError` | `code` (`ImportErrorCode`) + readable `message` + `diagnostics`. |

Worker entry: `src/workers/import.worker.ts` (binds `workerHandler.ts`; protocol in `protocol.ts`).
Each job receives a transferred copy of the bytes, and the worker never sends the file back.

## Pipeline (`build.ts`)

`source.ts` (zip sniff, `mxl.ts` container/opus/limits/CRC, `text.ts` encoding, `xml.ts`
order-preserving parse, `timewise.ts`) → `candidates.ts` (selection rules) → `read/part.ts`
(cursor model: divisions, backup/forward, chords, grace; attributes, directions, sound, barlines)
→ `skeleton.ts` (global staves top→bottom, bar durations, fill checks) → `navigation.ts`
(D.C./D.S./Coda/Fine plan) → `repeats.ts` + `occurrences.ts` (performance order) → `ottava.ts` (source spans, per-note shift, performed spans)
→ `sourceNotes.ts` (sounding/written, accidental context, clef, velocity) → `performance.ts`
(performed notes sorted by onset/staff/midi, tie chains, arpeggio groups) → `tempoMap.ts` →
`rolls.ts` → `hands.ts` → `events.ts` (key/meter/clef maps, pedals, dynamics) → `issues.ts`
(unsupported regions, timing issues) → `renderXml.ts` → `summary.ts`; `version.ts` hashes.

## Design notes and interpretations

- **Pitch (M1).** `<pitch>` is sounding; written = sounding − ottava shift, applied once. Ottava
  scope is per staff and `number`, half-open [start, stop) in source positions. A span is split
  where a repeat jumps; `startOcc`/`endOcc` are the bars holding the first and last displaced
  positions (the reference piece's 8va stop is written at the start of bar 4 but displaces only bar 3, so
  its span is bar 3: `startOcc = endOcc = 2`).
- **Context after a jump** (key, meter, clef, tempo, dynamics, ottava) is what the *written* score
  states at the jump target, not the last performed value. `renderXml` re-states key/time/clef/
  divisions where they differ and closes/reopens octave-shift brackets so they stay balanced.
  Before the first stated key the score is in C major, and before a staff's first stated clef that
  clef applies (treble/bass when the staff states none): a jump back into that stretch re-states
  them like written ones (key map event, restated `<key>`/`<clef>`).
- **Repeats (M5).** Forward/backward barlines (`times`), endings with number lists, sequential
  sections; a backward repeat inside an ending repeats up to the group's highest ending number.
  Endings without a repeat sign play in written order (warning).
- **D.C. / D.S. / To Coda / Fine (I4).** Read from `<sound>` dacapo/dalsegno/tocoda/coda/segno/
  fine (tokens link jump and target), `<segno/>`/`<coda/>` signs (directions and barlines) and the
  common words ("D.S. al Coda", "To Coda", "Fine", "Coda", 𝄋/𝄌), from all parts (also unselected).
  Bar granularity: instructions act at the end of their bar, signs mark the start of theirs (the
  next bar when written at the bar's end or on a right barline). Each jump is taken once, after
  its bar's own repeat; afterwards Fine ends the performance ("al Fine") or To Coda goes to the
  first coda sign after it ("al Coda"); without "al …" the mode is inferred (To Coda between target
  and jump → coda, else a Fine → fine, else to the end). After a jump, repeats and ending groups
  already completed are passed (last ending played) unless the words say "con repetizione" / "with
  repeats"; repeats first reached afterwards (a coda) are taken. Each followed step is an info
  diagnostic (`navigation-jump`, `navigation-to-coda`, `navigation-fine`). Not followed (written
  order, bar → `unsupported-repeat` with the reason): D.S. without a segno before it, "al Fine"
  without a Fine, "al Coda" without To Coda or coda sign, D.C. and D.S. in one bar, a jump inside a
  repeated section before its backward repeat, a To Coda that no followed jump uses.
- **Tempo.** `sound/@tempo` = quarter BPM; metronome beat unit incl. dots. In one direction, a
  sound/metronome disagreement is a `tempo-conflict` warning and the printed **metronome mark
  wins**. Several statements at one position: the last (document order) wins; a hidden
  (print-object="no" or sound-only) restatement of a printed mark is the file's playback
  realization (info `tempo-realized`; the reference piece does this at bars 39 and 57). Sound-only
  changes keep the last displayed beat unit. Tempo is read from all parts (also unselected).
  No numeric tempo → empty map + `tempo-missing`; the first tempo is used before its bar.
- **Sections (I12).** `ScoreModel.sections` (optional, only when found): `<rehearsal>` marks, and
  standalone words above the staff written like a heading (upright with an explicit normal style,
  bold or an enclosure; capitalized; not a tempo, expression, hand, ottava or D.C./D.S./Fine/To
  Coda word — a "Coda" heading counts), read from all parts (`sections.ts`). Each performed pass
  of a marked bar gets the label; one label per bar, rehearsal marks first. Display only (the
  overview). Packages imported earlier have no sections; no `IMPORTER_VERSION` change.
- **Timing issues.** Fermatas (notes, rests, barlines), caesuras, unrealized verbal changes
  (rit./accel./… with no numeric tempo in the same or next bar; "a tempo"/"Allegro"… without a
  number at that point; opening tempo words are ignored), rubato, metric modulation.
- **Hands (M2).** Per voice; the home staff (most notes; top selected staff → R, below → L)
  decides, confirmed from the start. A cross-staff voice gets a `hand-cross-staff` info note. Only
  a genuinely split voice (notes on both staves, part not numbered 1–4 / 5–8 by home staff, minority
  share ≥ ⅓) is in `ambiguousVoices` with a `hand-ambiguous` warning until confirmed. The
  convention counts only when the part's numbering covers both staves (one voice 1 on both
  staves falls back to the share rule). A note without `<voice>` takes its staff's conventional
  voice (staff 1 → "1", staff 2 → "5", `noteVoice`); `renderXml` writes it into such notes
  (except voice 1, OSMD's default) so the engraver's voices match.
- **Endings that open a repeat.** An ending is chosen with the enclosing section's pass before a
  forward repeat on the same bar opens the next section (`|: 1 [1. 2 :| [2.|: 3 | 4 :| 5`).
- **Rolls.** Group = same occurrence + onset + part + `number`; without a number each voice's chord
  is its own roll. Spread 120 ms at 1×, ≤ ½ interval to the next written attack (any part) and
  ≤ ½ the earliest member ending (tie chain included); distinct fresh pitches evenly spaced in the
  marked direction (default up); explicit `attack` offsets are kept (`SourceNote.attack`, so
  `withUserTempo` realizes them at the practice tempo). No tempo → offsets 0.
- **Accidental context.** Key at onset + carried accidentals earlier in the bar on the displayed
  staff, keyed by written step+octave; grace notes carry into their principal note; tie
  continuations do not carry.
- **Velocity (M3).** `sound/@dynamics` × 0.9; bare marks use MuseScore's values (p 49, f 96…);
  note `dynamics` attribute overrides; default 80. Dynamics apply part-wide.
- **Unsupported (M4).** Grace, ornaments (`<ornaments>` except accidental marks), tremolo,
  non-integer alter, senza-misura, unpitched notes: bars become `UnsupportedRegion`s; notes stay
  in the model (grace notes as `grace: true`, duration 0). Cue notes (`<cue/>`) are not
  unsupported: they stay in the model as `cue: true` and every consumer skips them (I13).
- **renderXml.** Selected parts (and their part-groups), header without page credits, measures
  numbered 1…N, `<print>`, repeat/ending barlines and multi-rest styles removed. Navigation is
  display-only: a followed D.C./D.S./To Coda/Fine is shown only on the occurrence where it acts,
  unfollowed ones on every pass, a segno/coda sign once (where a jump lands, else its first pass);
  `<sound>` navigation attributes are dropped and navigation words end with U+2060 so OSMD draws
  them as text and builds no repetition structure of its own. Octave-shift
  markup is re-written from the performed spans (same type/size/number/attributes) and placed
  for OSMD 2.2.1's reader, which starts a shift at the cursor but ends it — inclusively — at the
  onset of the *last note read*: each stop follows the chord group at the last position before
  the span end; starts are placed by `<forward>`/`<backup>`. Verified per note against OSMD's
  rule in `tests/unit/import/osmd-load.test.ts` (fixtures, 120-bar score, reference piece).
- **Identity.** `scoreVersionId` = SHA-256 of (source SHA-256, entry, sorted part ids,
  `IMPORTER_VERSION`). `meta.importerVersion`/`rollPolicyVersion` are always set and preserved by
  `applyHandAssignment` / `withUserTempo`.
- **Limits** (`limits.ts`): input 32 MiB, XML 64 M chars / 4 M elements, zip entries/expansion/
  ratio checked before inflating, CRC verified, 10 000 bars, 300 000 notes, 20 000 occurrences.
  DOCTYPE entity declarations are refused; external DTDs/entities are never resolved.

## Spec coverage

| Item | Status |
| --- | --- |
| .musicxml / .mxl (container, several rootfiles, opus in archive) / .xml by content; unrelated XML refused | done |
| Readable diagnostics: malformed XML (line/col), encodings, damaged zip, CRC, missing rootfile, limits | done |
| Candidates + part selection (one 2-staff part or two 1-staff parts; suggested selection) | done |
| Divisions, backup/forward, chords, voices, staves, rests, dots, tuplets, pickups, ties | done |
| Key/meter/clef maps (clef per staff, mid-bar changes), clef key per note | done |
| Tempo map (sound vs metronome, dotted units, conflicts, missing tempo) | done |
| Ottava scope (8va/8vb/15ma/15mb), affected notes, performed spans | done |
| Repeats + endings unfolded with passes; D.C./D.S./To Coda/Fine followed (ambiguous ones reported) | done |
| Hands per voice, ambiguity, `applyHandAssignment` | done |
| Arpeggio groups, reference roll offsets, `withUserTempo` | done |
| Dynamics, pedals (sustain/sostenuto/soft, change), fingering | done |
| Unsupported regions, timing issues | done |
| renderXml read by OSMD 2.2.1 (measures, notes, ottava brackets and displaced notes match the model) | done (reader + OSMD's displacement rule; drawing is render/'s gate) |
| Worker + client (progress, cancellation, one job, release) | done, tested with an in-process fake worker; real `Worker` in browsers not yet exercised (e2e, WP8) |
| Fixtures (`tests/fixtures/scores/`, 24 files) and `generateLongScore(500)` | done |
| Reference-piece facts (59 bars, 8va written bars 3–4 / displacing bar 3, rolls bars 23 and 59, P1:5 ambiguous, 66 BPM) | done |
| 500-measure import time | done (~0.7 s in Node; 🔒 iPad timing) |

## Remaining work

1. Exercise the real worker + client in a browser (Playwright e2e in WP8: import a fixture,
   cancel mid-import, check that no UI update follows and that the worker is released).
2. Decide the open questions (see the WP1 report): conflict policy (metronome wins), cue notes,
   whether hand reassignment should change the comparison context.

## Known gaps

- Packages imported before importer 0.2.0 have no `SourceNote.attack`; `withUserTempo` gives
  their explicit rolls the default spread.
- Navigation is per bar: a Fine or jump written mid-bar acts at the bar's end; a jump target
  written mid-bar is its bar's start.
- Cue notes are performed notes (no `cue` flag on `PerformedNote`); their bars are unsupported.
- Nested repeats are unfolded innermost-first with a warning.
- Per-staff key signatures (`<key number>`), composite meters (sum used) and `<transpose>` parts
  are simplified with diagnostics.
