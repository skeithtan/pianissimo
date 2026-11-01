# render/ — notation renderer (WP6)

OSMD 2.2.1 behind a `RendererAdapter`, a serializable `PreparedLayout`, and a framework-free
`StripView` for the practice strip. `keyboard/` (keyboard guide) is a separate package.

## Public API (`src/render/index.ts`)

- `new OsmdRenderer().prepare(input: RenderInput, opts: PrepareOptions): Promise<PreparedLayout>`
  — loads OSMD with a dynamic `import()` (library view never fetches it), engraves `renderXml` as
  one horizontal staffline in a hidden attached container, maps graphics to
  `PerformedNote.index`, reserves label boxes, partitions into segments, discards the SVG tree and
  the OSMD instance. Progress via `onProgress(stage, f)`; `signal` cancels between stages.
  `RenderInput` = `ScorePackage.renderXml` + `ScoreModel` fields (the model satisfies it).
- `prepareLayout(adapter, cache | null, input, opts)` — cache hit or prepare + put.
- `LayoutCache` (`get(key)`, `put(layout)`), `MemoryLayoutCache` (byte-bounded LRU),
  `storeLayoutCache(store)` adapting the storage module's `getLayout/putLayout`, `layoutKey(...)`
  (score version + renderer version + label chars/font + segment width; zoom is not in the key),
  `isPreparedLayout(v, key)` (format/key check + allow-list scan of all markup).
- `new StripView(host, layout, opts)`:
  `setCursor(posWholeNotes, {smooth})`, `wrapTo(posWholeNotes)` (loop wrap: a quick 320 ms
  ease-out pan back to the loop start; past 2.5 viewports it lands 1.5 viewports short of the
  target without a transition, then pans the rest), `setTargets(notes)`, `setAccepted(notes)`,
  `setAutomatic(notes)`, `setPlaybackHighlights(notes)`, `setSubduedHand('L'|'R'|null)`,
  `setWrongMarker(on)`, `pulseWrong()` (cursor tint only), `setEarlyMarker(on)` (amber tint for a
  too-early press; the wrong tint wins), `setOttavaEmphasis(spans)`,
  `setLabels(Map<note, text>)`, `setLabelOpacity(Map<note, 0..1>)` (every frame OK),
  `setLoop({fromOcc,toOcc,start?,end?}|null)` (a `PassageRange`; exact edges draw a note-level band),
  `setSnapPositions(onsets)` (the hands' exact onsets: loop edges and the dragged playhead snap to
  them), `setCursorDraggable(bool)`, `setLoopEditable(bool)`, `setLoopSelectMode('off'|'tap')`,
  `setCursorAction(visible)` (circular "Repeat from here" button on the cursor bar, fades; inert
  while hidden; no pressed state), `setCorrections(marks: CorrectionMark[])` (teacher's red-pen
  marks after an attempt, `{ notes, kind, text }` with kind `'wrong'|'early'|'late'|'accidental'|
  'octave'|'spread'|'tie'|'pedal'`; `[]` clears them),
  `setBrowseEnabled(bool)`, `returnToCurrent()`, `isBrowsing()`, `setZoom(s)`, `zoom()`,
  `occAt(clientX)`, `visibleLabels()`, `stats()`, `flushNow()` (tests), `destroy()`.
  Callbacks: `onBrowse`, `onSeekRequest(occ)` (tap outside select mode, also a tap on the cursor),
  `onCursorSeek(position) → boolean|void` (dragged playhead released on a note; `false` puts it
  back), `cursorDragLabel(position)` (readout text), `onLoopChange(range|null)`,
  `onLoopSelectModeChange`, `onVisibleLabels(addedNotes)`, `onZoomChange`, `onCursorAction()`
  (`cursorActionLabel` overrides the accessible name).
- Pure helpers: `positionToX`, `occAtX`, `occAtPosition`.
- **Page mode (portrait)**: `PrepareOptions.mode: 'page'` + `pageWidth` (layout px the systems
  wrap to; `pageWidthFor(stageWidth, zoom)` = (stage − 2 × 16 px) / zoom, rounded to 8) prepares
  a page layout: `layout.mode = 'page'`, `layout.systems` (`SystemGeometry`: bar range, page y
  extent, staves), `system` on occurrences, notes and segments (`SegmentData.y0/y1`),
  `params.pageWidth`, `contexts` / `contextChanges` empty. Keyed `…|page<width>`; the strip's key
  is unchanged. `new PageView(host, layout, opts: PageOptions)` implements the strip's whole
  public API (the practice session's `StripSink` + the view's `StripHandle`) with page
  semantics, plus `occAt(clientX, clientY?)`, `cursorClientX()`, `currentSystem()`;
  `PageOptions.followOffset` (default 1/4) and `zoomDebounceMs` (250).

## Design

- **Prepare** (`osmd/adapter.ts`): rules `SheetMaximumWidth` lifted (OSMD otherwise wraps a
  "single" staffline into new systems past 32 767 px — asserted to be one system), multi-rest
  generation off, measure numbers/titles off. Spacing default `VoiceSpacingMultiplierVexflow 1.4`
  (OSMD 0.85): room for a label beside nearly every notehead in one engraving; if > 0.5 % of
  labels still need a callout, spacing widens for both staves together (factor from measured
  demand, clamped 1.15–2) and re-engraves, max 3 engravings.
- **Extraction** (`osmd/extract.ts`): OSMD graphical model → per-notehead `GraphicNote`
  (occ = measure index, staff, voice, onset fraction, sounding MIDI = `halfTone + 12`, grace,
  notehead bbox, staff-entry x); measure x ranges + onset anchors; staff lines; ottava brackets
  (VexFlow draws them as loose `text`/`path` siblings — found from `VexFlowOctaveShift` start/stop
  notes); clef/key/time glyph groups; label obstacles = every SVG leaf except staff lines, long
  curves/beams sampled along their outline.
- **Mapping** (`mapping.ts`, pure): strict key (occ, staff, voice, onset, midi, grace), then
  relaxed passes (no voice, no staff, occ+onset+pitch, microtone fractional pitch) counted in
  `report.relaxedMatches`; a unison engraved once is shared (one label unit).
- **Label font** (R14): `LABEL_FONT_FAMILY` = SF Compact (when installed) → self-hosted
  "Pianissimo Label" (Inter SemiBold Basic Latin + Noto Music ♯ ♭ ♮ 𝄪 𝄫 by unicode-range,
  `public/fonts`, OFL, 10.0 + 2.9 kB woff2, `@font-face` in strip.css, `font-display: block`) →
  system UI. `loadLabelFont` runs before measuring in `prepare` and when a strip mounts.
- **Label metrics** (`labels/metrics.ts`): the reserved box is the widest label the naming family
  of `maxChars` can produce (every name × ♯ ♭ ♮ 𝄪 𝄫/none × octave digit), measured once per text
  with canvas `measureText` in the label font (600 weight, `LABEL_FONT_PX` 13.5 px by default;
  `ADAPTER_VERSION` pn-5) and cached for
  the session; + 2 px, 1.2 em high. Measure numbers are measured in the `.pn-mnum` font (500,
  11 px). No canvas or a rejected font → the deterministic 0.62 em (labels) / 6.4 px per char
  (numbers) estimate; `PrepareOptions.textMeasurer` injects a measurer (tests).
- **Measure numbers** (`labels/numbers.ts`, pure, R6): each box starts 2 px right of its barline,
  19 px above the top staff line, and moves up in 3 px steps until it clears every engraved mark
  above the staff and the numbers already placed (never down into the staff). Label layout
  takes the boxes as obstacles, so labels never cover numbers either.
- **Labels** (`labels/layout.ts`, pure): the measured worst-case box for every unit, preference
  right → left (small x nudges) → half-height stagger (only if nearer its own head) → stack with
  leader → callout above/below the staff with leader (always succeeds, extends vertical label
  space). Never omitted or shrunk.
- **Segments** (`partition.ts`): measure-range segments ≥ 400 px (a measure or two, PF6). A
  top-level unit belongs to the segment holding its center and is also copied into every segment
  it reaches more than 1.5 px into, clipped by the segment viewBox (2 px seam overlap), so ties/
  slurs/hairpins/pedal lines cross boundaries intact while a neighboring measure whose barline
  only touches the boundary is not copied. Noteheads tagged `data-n`, glyphs `data-h` (hand),
  ottava parts `data-o`.
- **Sanitization** (`sanitize.ts`): element/attribute allow-list, no `url(`/`javascript:`,
  geometry rounded (0.1 px paths), default attributes dropped, engraver black → `currentColor`.
  `isSafeSvgMarkup` (cached layouts) also finds attributes right after a quote or `/` and rejects
  character references other than `&amp; &lt; &gt; &quot; &nbsp;`.
- **Cursor path** (`strip/cursorPath.ts`, pure): knots are every onset anchor in global position
  order; a bar's last onset glides straight to the next bar's first onset. Continuous following
  uses monotone cubic interpolation with continuous speed and exact onset alignment. A held
  practice gate therefore leaves the required note exactly beneath the cursor.
- **StripView** (`strip/`): content layer with `translate3d + scale` only; the screen-space cursor
  stays at 1/3 throughout playback, browsing, zoom, and pointer/keyboard seeks. Leading/trailing
  space lets the first/final notes reach that same anchor. The cursor bar spans the staves plus
  56 px at each end, faded by a vertical mask. Far jumps are unanimated (loop wraps pan, `wrapTo`);
  segments mount for viewport ± 1 viewport (both old and new views during smooth scroll), with bounded
  detached LRU and O(changed notes) frame updates. Labels exist only while opacity > 0.
  Sticky clef/key/meter includes the five lines of each staff with matching theme opacity.
  A stationary viewport mask fades moving notation into the signatures without a divider.
  Zoom fits both the staff height and the widest context before the fixed cursor, keeping the
  active notes unobscured on narrow screens. The fit is applied to the requested zoom on every
  mount and resize without `onZoomChange` (a short strip never lowers the saved preference; the
  zoom comes back when there is room); pinch, ctrl-wheel and `setZoom` report. A notehead that
  PF6 copied into a neighboring segment gets the note classes there too, but the halo / ring /
  play mark lives only in the owning segment.
  A mid-bar clef change switches the sticky clef at its engraved change clef (else at its onset),
  not at the barline (`ADAPTER_VERSION` pn-7).
- **Theme**: no colors in cached SVG; `--score-paper/--score-ink/--score-ink-muted`, `--danger`,
  `--color-loop`, `--color-target/accepted`, `--accent`, motion tokens with fallbacks; switching
  `data-theme` / `data-score-paper` recolors instantly without re-engraving.
- **Feedback**: wrong-key state tints the cursor. No wrong-key text or badge is drawn over the
  score while playing; the app supplies the screen damage indicator. Ottava emphasis stays available.
- **Teacher corrections** (`setCorrections`): after an attempt, a hand-drawn red ring (`--danger`,
  2.5 px, a single pen stroke slightly more than once around with growing radius, rotated −3°)
  around each mark's noteheads — one ring per staff, union box + 10 px — and one text per mark
  (13 px semibold label font, red, `pn-corr-halo`: a 3 px `paint-order: stroke` halo in the score
  paper). Every kind uses the same pen; the kind is a class (`pn-corr-<kind>`). Labels never sit
  over notation: a mark whose top ring is on the upper half of the staves puts its label in a band
  above the top staff, otherwise below the bottom staff, centered on its nearest ring with a 1.5 px
  leader (`pn-corr-leader`) to the ring's edge. Row 0 starts beyond the top (bottom) staff line,
  the mark's ring, measure numbers, ottava brackets and note names under the label's width, and
  36 px beyond the nearby noteheads of that staff (stems and beams). Rows are 16 px; left to right,
  a label whose box (canvas-measured, else 0.62 em per character, + 6 px gap) would overlap one
  already placed in its band moves one row farther from the staff, up to three rows, else its text
  and leader are dropped and the ring stays. A chord on both staves shares one label (top band).
  A `'spread'` mark with rings on several staves joins them with a 2.5 px line (`pn-corr-link`)
  along their centers' line, from ring edge to ring edge, drawn under the rings in the same SVG;
  a `'pedal'` mark writes an italic "Ped." (`pn-corr-ped`) before its text. Each mark is one small
  SVG on `.pn-corrs`
  inside the scaled content (layout px; `shared/corrections.ts`, used by the page too, per system), so it scrolls and zooms with the notation; DOM is built
  once in the next frame after a call (the same marks again are a no-op), nothing per frame, no
  pointer events. Fade in 300 ms staggered 40 ms left to right; replaced or cleared marks fade out
  in 200 ms and are removed on `animationend` (fallback timer 260 ms). Reduced motion: opacity
  only, no stagger.
- **Loop UI**: gray band over the passage, white rounded chevron handle tabs (40×110, counter-
  scaled to stay that size at any zoom), ✕ clear button (88 px; 56 px when the band is under
  150 px on screen, never hidden while editable) centered; pointer capture, never inverts,
  `setLoopEditable(false)` hides controls. Handles snap to loop knots (`strip/snap.ts`:
  every barline plus every onset of the hands inside a bar; without `setSnapPositions` barlines
  only; a drag ends uncommitted when the loop is replaced, cleared or locked meanwhile): a note-level edge is drawn halfway between the edge note and the engraved entry before
  it, a loop keeps at least one note, arrow keys step one note (Shift: one barline), and a drag
  near the strip's edge scrolls the music (then stays there, browsing).
- **Playhead drag**: while `setCursorDraggable(true)`, the ≥ 44 px cursor grip scrubs the music
  beneath the fixed bar. The selection snaps to note onsets, a bar/beat pill shows above the bar,
  and edge dragging continues through the score. Release calls `onCursorSeek`; refusal restores
  the prior note under the bar. One layout read per gesture, then O(log onsets) arithmetic.
- **Keyboard playhead** (U25): the grip is a horizontal `role="slider"` (`cursorLabel`), focusable
  exactly while draggable (`inert` otherwise). ← / → seek to the previous / next snap onset,
  Shift+← / → to the first onset of the previous / next bar, Home / End to the ends; each press
  calls `onCursorSeek` and moves the music beneath the fixed cursor unless refused. `aria-valuetext` and the bar/beat pill
  (visible with `:focus-visible`) come from `cursorDragLabel`; they are set on focus and per key,
  never per frame.

## Page mode (`osmd/page.ts`, `page/`)

- **Prepare** (`preparePage`, dispatched from `OsmdRenderer.prepare`): OSMD engraves a normal
  endless page (`renderSingleHorizontalStaffline: false`) in a hidden container `pageWidth` wide,
  page margins 1 / 2.5 OSMD units (room right of a system's last notes for their labels).
  `extractPage` reads the strip's per-note / per-measure / ottava geometry plus each system's
  staves, `g.staffline` groups (braces go to the nearest system), bar range and its own label
  obstacles. The measure number is placed (R6) for the bar opening each system only; labels are
  reserved per system with the same `layoutLabels`, against that system's marks. One engraving by
  default: OSMD justifies every system, so widening spacing only pushes bars onto new lines (the
  reference piece went to one bar per line) while the callouts stayed (36 → 32); the remaining callouts are
  the spec's linked callouts.
- **Restacking** (`page/stack.ts`): OSMD's vertical spacing knows nothing about reserved labels, so
  each system's content extent (marks, labels, number, ottava brackets; + 6 px) is stacked below
  the previous one with `PAGE_SYSTEM_GAP` 36 px, and every coordinate of that system moves by the
  same `dy` into page space. Segments (`partitionPage`): one per system, viewBox in page y, the
  engraving wrapped in one `translate(0 dy)` group (systems share no marks: OSMD draws each tie /
  slur / bracket piece in its own system's staffline).
- **View** (`page/PageView.ts`, `page.css` on top of strip.css: the root is `.pn-strip.pn-page`,
  so every token, note state, label, cursor, loop and correction style is the strip's): a
  vertically scrolling sheet (`overflow-y: auto`, `overscroll-behavior: contain`, locked while
  browsing is disabled), content scaled by the zoom and centered with ≥ 16 px gutters, systems
  mounted for the visible range ± one viewport with the strip's bounded LRU
  (`page/segments.ts`, a copy of `SegmentStore` by y). The cursor bar (R13 look, staves + 96 px
  faded) rides on the sheet at the position's x along its system's `CursorPath` (knots = that
  system's onsets); 180 ms glide per seek, per-frame while following, a jump at a system change.
  The repeat button rides on it. **Follow**: when the system changes, and on a seek / wrap /
  return, the sheet scrolls so that system's top sits a quarter down (one `scrollTop` write plus
  a 300 ms Web Animations FLIP glide in `--ease-standard`; reduced motion: instant); never during
  a line, never while browsing (a scroll the view did not write, with browsing enabled →
  `onBrowse(true)`, Return button). A tap is a seek and ends browsing. **Loop**: one band per
  system crossed (`PageGeometry.loopBands`), handles at the two edges, ✕ on the first band; a
  handle drags along its own system (snap knots of that system), arrow keys step across systems.
  **Playhead drag**: within the current system; keyboard (← → Shift Home End) across systems.
  **Zoom**: pinch / ctrl-wheel / `setZoom` scale the page at once; 250 ms later
  `onZoomChange(scale)` asks the owner to re-prepare at the new page width.
- Reference piece at 788 px (Chromium, this Mac): 1 engraving, 1.16 s prepare, 1353/1353 mapped, 8va
  mapped, 36 callouts (2.7 %), 1.7 MB of segments. Real iPad numbers still needed.
- **Copied from the strip** (to deduplicate later): note flags + `paintNote`, label painting and
  visible-label reporting, `withEdge`, loop-handle key stepping, cursor keyboard stepping, the
  icons, `SegmentStore` (→ `page/segments.ts`). Corrections are shared, not copied
  (`shared/corrections.ts`: page labels use their system's staves and marks).
  Imported unchanged: `CursorPath`, `snap.ts`, `loop.ts`, `scroll.ts` helpers.
- Not done: dragging a loop handle or the playhead across systems (keyboard only); the ottava
  reminder is one pill at the cursor (the strip has one per staff); pinch is synthetic-tested only.

## Measurements (this container, x86; Playwright, all-note labels, 1180×400 strip)

| | Reference piece 59 bars (Chromium / WebKit) | importer `generateLongScore(500)` | renderer `long-500` |
| --- | --- | --- | --- |
| OSMD load (first) | 366 / 204 ms | – | – |
| engrave (all iterations) | 810 / 744 ms (1 it.) | 1801 / 3036 ms (2 it.) | 1086 / 1647 ms (1 it.) |
| extract + map / labels / partition | 238 / 17 / 176 ms (Chr.) | 425 / 53 / 693 ms | 175 / 23 / 670 ms |
| total prepare | 1.63 / 1.85 s | 3.1 / 5.1 s | 2.0 / 3.5 s |
| SVG nodes (discarded) / segment bytes | 12 380 / 2.1 MB | 47 365 / 10.0 MB | 48 986 / 10.0 MB |
| strip width / segments | 34 604 px / 18 | 176 935 px / 100 | 164 348 px / 86 |
| mapping | 1353/1353, 0 unmapped graphics, 8va 1/1 | 4875/4875, ottavas 31/31 | 5680/5680, 13/13 |
| callouts | 4 (0.3 %) | 0 | 3 / 0 |
| traversal ×2 max mounted segs / nodes / label nodes / cached | 4 / 4 791 / 304 / 4 | 4 / 2 898 / 195 / 4 | 4 / 3 352 / 250 / 4 |
| simulated practice (50 ms steps, smooth): frame p95 / max | 0.5 / 9.6 ms (WebKit 1 / 8) | 1.1 / 3.3 ms | 0.4 / 3.2 ms |
| long tasks during practice | none | none | none |

Mounting one segment (parse, style, layout) is the strip's one synchronous chunk while the music
scrolls. Reference piece, one measure per segment (PF6): 257 nodes, ≈ 3 ms on the Chromium 4×
stand-in (1 ms parse + 2 ms layout; worst 5 ms), ≈ 6 ms in WebKit on the dev machine (worst 12).
Before PF6 (1600 px segments carrying both neighboring measures): 996 nodes, 8.5 ms (worst 12)
and 8.2 ms (worst 13). A synchronous far seek mounts the visible segments at once. Real tablet
numbers are still needed (spec: desktop numbers are not proof).

## Spec coverage

Done: OSMD adapter via dynamic import; single horizontal staffline (incl. long scores); note ↔
graphic mapping with report (0 unmapped on the reference piece, all importer fixtures, both 500-bar scores);
ottava bracket mapping; clef/key/meter change positions + sticky edge; segmentation with crossing
marks; bounded mounting + LRU + counters; serializable layout + cache interface + key + validation;
StripView fixed cursor/scroll/zoom/drag-browse/return; targets, accepted, automatic, playback,
subdued hand; wrong marker; ottava emphasis + offscreen reminder; collision-aware labels with
reserved space, per-note opacity, visible-label reporting; loop band/handles/tap selection/clear;
SVG sanitization; dark mode; harness + Playwright (Chromium + WebKit) + Vitest.

Done in WP12: label and measure-number widths from the real font (canvas, cached); measure
numbers placed clear of engraved marks (fixtures + reference piece: 0 ink overlaps, 24 on the reference piece at
the old fixed height) and kept as label obstacles.

Partial: pinch tested with synthetic pointers only;
sticky key signature after a change uses the engraved change glyph (cancellations dropped by
glyph count heuristics); `onSeekRequest` fires for any tap, the caller decides whether seeking is
allowed.

Left: iPad/MIDIWeb measurements; idle-time pre-parsing of upcoming segments; layout
re-preparation on `maxChars` change is the caller's job (`prepareLayout` with new sizing);
storage-backed `LayoutStore` (WP5) wiring; keyboard guide is WP3.

## Decisions / interpretations

- R1 refinement: OSMD `SheetMaximumWidth` must be raised for one-staffline layout.
- Spacing default 1.4 (label-aware); widen only when > 0.5 % of labels would need callouts;
  remaining callouts are the spec's "nearby stacked callout linked to the correct notes".
- Measure numbers drawn by the app above each bar ("12", "12 (pass 2)"), raised past engraved
  marks where needed (`ADAPTER_VERSION` pn-3 invalidates layouts cached with estimated widths).
- Unison twins in two voices share one label; microtones map by nearest pitch (relaxed).
- Wrong-key cursor tint stays until the group completes (`setWrongMarker(false)`);
  `pulseWrong()` per error, with no overlaid text.
- Zoom is capped so both staves always fit the strip height.
- The harness keeps a copy of the score-paper tokens (`tests/harness/theme.css`) until the
  shell's global.css lands; values are identical.
