/**
 * Source notes: one per pitched `<note>` of the selected parts, in document order.
 *
 * - Sounding pitch = MusicXML `<pitch>` (DECISIONS M1), transposed only for `<transpose>` parts.
 * - Written = sounding shifted back by the active ottava on the note's displayed staff.
 * - Accidental context (for naming, never for pitch): key signature at the onset plus the
 *   accidentals carried earlier in the same bar on the same staff, keyed by written step+octave.
 *   Grace notes carry into the note they ornament; tie continuations do not carry.
 * - Clef = the clef governing the displayed staff at the onset.
 * - Velocity = note `dynamics` attribute, else the latest dynamics at the onset (× 0.9 of the
 *   MusicXML percentage, DECISIONS M3), else mezzo-forte (80).
 */
import { ZERO, cmp } from '../music/rational'
import { STEPS, type Spelling, type Step, spellingToMidi, shiftOctaves } from '../music/pitch'
import type { AccidentalContext, ClefDef, ClefKey, SourceNote } from '../model/score'
import type { DiagnosticSink } from './diagnostics'
import type { TimingMark, UnsupportedMark } from './issues'
import type { OttavaLookup } from './ottava'
import { PosIndex } from './positions'
import type { RawClef, RawKey, RawNote, SrcPos } from './read/types'
import { clampVelocity } from './read/values'
import type { Skeleton } from './skeleton'

export const DEFAULT_VELOCITY = 80

const SHARPS: readonly Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const FLATS: readonly Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F']

function keyAlter(step: Step, fifths: number): number {
  if (fifths > 0) return SHARPS.slice(0, fifths).includes(step) ? 1 : 0
  if (fifths < 0) return FLATS.slice(0, -fifths).includes(step) ? -1 : 0
  return 0
}

/** Clef identity for label rules: "G2", "F4", "C3", "G2-8", "F4+15", or the sign for others. */
export function clefKeyOf(clef: ClefDef): ClefKey {
  if (clef.sign === 'percussion' || clef.sign === 'TAB' || clef.sign === 'none') return clef.sign
  const oc = clef.octaveChange
  const suffix =
    oc === 0 ? '' : `${oc > 0 ? '+' : '-'}${Math.abs(oc) === 1 ? 8 : Math.abs(oc) === 2 ? 15 : Math.abs(oc)}`
  return `${clef.sign}${clef.line}${suffix}`
}

/** Default clef when a staff never states one: treble for the top staff, bass below. */
export function defaultClef(staffNumber: number): ClefDef {
  return staffNumber === 1 ? { sign: 'G', line: 2, octaveChange: 0 } : { sign: 'F', line: 4, octaveChange: 0 }
}

/** Apply `<transpose>` (written → sounding) to a spelling. */
function transposeSpelling(
  p: Spelling,
  t: { readonly chromatic: number; readonly diatonic: number; readonly octaveChange: number },
): Spelling {
  const fromIndex = STEPS.indexOf(p.step) + t.diatonic
  const octaveShift = Math.floor(fromIndex / 7) + t.octaveChange
  const step = STEPS[((fromIndex % 7) + 7) % 7]!
  const octave = p.octave + octaveShift
  const targetMidi = spellingToMidi(p) + t.chromatic + 12 * t.octaveChange
  const alter = targetMidi - spellingToMidi({ step, alter: 0, octave })
  return { step, alter, octave }
}

export interface SourceNoteResult {
  readonly notes: SourceNote[]
  /** Raw note per source note id (same index). */
  readonly raw: RawNote[]
  /** Clef key and velocity per source note id (same index). */
  readonly extras: { readonly clef: ClefKey; readonly velocity: number }[]
  readonly unsupported: UnsupportedMark[]
  readonly timing: TimingMark[]
  /** Clef changes per global staff in source order (with defaults filled in). */
  readonly clefsByStaff: ReadonlyMap<number, PosIndex<RawClef>>
}

export function buildSourceNotes(skeleton: Skeleton, ottavas: OttavaLookup, diag: DiagnosticSink): SourceNoteResult {
  const notes: SourceNote[] = []
  const raw: RawNote[] = []
  const extras: { clef: ClefKey; velocity: number }[] = []
  const unsupported: UnsupportedMark[] = []
  const timing: TimingMark[] = []
  const clefsByStaff = new Map<number, PosIndex<RawClef>>()
  let id = 0
  let outOfRange = 0

  for (const part of skeleton.parts) {
    const keys = new PosIndex<RawKey>(part.data.keys)
    const dynamics = new PosIndex(part.data.dynamics)
    for (let s = 1; s <= part.staffCount; s++) {
      const list = part.data.clefs.filter((c) => c.staff === s)
      if (list.length === 0 || cmp(list[0]!.at, ZERO) > 0 || list[0]!.m > 0) {
        if (list.length === 0) {
          diag.warn(
            'clef-missing',
            `Staff ${s} of “${part.name}” states no clef; ${s === 1 ? 'treble' : 'bass'} is assumed.`,
          )
        }
        list.unshift({ m: 0, at: ZERO, staff: s, clef: list[0]?.clef ?? defaultClef(s) })
      }
      clefsByStaff.set(part.staffOffset + s - 1, new PosIndex(list))
    }

    // Group notes per (measure, staff) to derive accidental context in onset order.
    const groups = new Map<string, RawNote[]>()
    for (const n of part.data.notes) {
      if (n.rest) {
        if (n.fermata) timing.push({ m: n.m, at: n.at, kind: 'fermata', text: 'fermata' })
        continue
      }
      const k = `${n.m}|${n.staff}`
      let g = groups.get(k)
      if (!g) groups.set(k, (g = []))
      g.push(n)
    }
    const contexts = new Map<RawNote, AccidentalContext>()
    const writtenOf = new Map<RawNote, { written: Spelling; sounding: Spelling; shift: number }>()
    for (const g of groups.values()) {
      const ordered = [...g].sort(
        (a, b) => cmp(a.at, b.at) || (a.grace === b.grace ? 0 : a.grace ? -1 : 1) || a.docOrder - b.docOrder,
      )
      const carried: Array<[Step, number, number]> = []
      let i = 0
      while (i < ordered.length) {
        const head = ordered[i]!
        let j = i
        while (j < ordered.length && cmp(ordered[j]!.at, head.at) === 0 && ordered[j]!.grace === head.grace) j++
        const pos: SrcPos = { m: head.m, at: head.at }
        const fifths = keys.at(pos.m, pos.at)?.fifths ?? 0
        const snapshot: AccidentalContext = {
          keyFifths: fifths,
          carried: carried.map((c) => [c[0], c[1], c[2]] as const),
        }
        const batch = ordered.slice(i, j)
        for (const n of batch) {
          contexts.set(n, snapshot)
          if (!n.pitch) continue
          const staffIndex = part.staffOffset + n.staff - 1
          const span = ottavas.find(staffIndex, { m: n.m, at: n.at })
          const shift = span?.shift ?? 0
          const sounding = part.data.transpose ? transposeSpelling(n.pitch, part.data.transpose) : n.pitch
          const written = shiftOctaves(n.pitch, -shift)
          writtenOf.set(n, { written, sounding, shift })
        }
        for (const n of batch) {
          if (n.tieStop || !n.pitch) continue
          const w = writtenOf.get(n)!.written
          const existing = carried.findIndex((c) => c[0] === w.step && c[1] === w.octave)
          if (existing >= 0) carried[existing] = [w.step, w.octave, w.alter]
          else if (w.alter !== keyAlter(w.step, fifths)) carried.push([w.step, w.octave, w.alter])
        }
        i = j
      }
    }

    for (const n of part.data.notes) {
      if (n.rest) continue
      if (n.unpitched || !n.pitch) {
        unsupported.push({ m: n.m, kind: 'non-piano', detail: 'unpitched notes' })
        continue
      }
      if (n.grace) unsupported.push({ m: n.m, kind: 'grace', detail: '' })
      if (!Number.isInteger(n.pitch.alter)) unsupported.push({ m: n.m, kind: 'microtone', detail: '' })
      for (const o of n.ornaments) {
        unsupported.push(
          o === 'tremolo' ? { m: n.m, kind: 'tremolo', detail: '' } : { m: n.m, kind: 'ornament', detail: o },
        )
      }
      if (n.fermata) timing.push({ m: n.m, at: n.at, kind: 'fermata', text: 'fermata' })
      if (n.caesura) timing.push({ m: n.m, at: n.at, kind: 'other', text: 'caesura' })

      const staffIndex = part.staffOffset + n.staff - 1
      const pitchInfo = writtenOf.get(n)!
      const midi = Math.round(spellingToMidi(pitchInfo.sounding))
      if (midi < 21 || midi > 108) outOfRange++
      const clefRaw = clefsByStaff.get(staffIndex)?.at(n.m, n.at)
      const velocity =
        n.dynamicsPct !== undefined
          ? clampVelocity(n.dynamicsPct * 0.9)
          : (dynamics.at(n.m, n.at)?.velocity ?? DEFAULT_VELOCITY)
      const note: { -readonly [K in keyof SourceNote]: SourceNote[K] } = {
        id: id++,
        measure: n.m,
        partId: part.id,
        staff: staffIndex,
        staffNumber: n.staff,
        voice: n.voice,
        onsetInMeasure: n.at,
        duration: n.duration,
        sounding: pitchInfo.sounding,
        written: pitchInfo.written,
        midi,
        ottavaShift: pitchInfo.shift,
        chord: n.chord,
        tieStart: n.tieStart,
        tieStop: n.tieStop,
        grace: n.grace,
        cue: n.cue,
        accidentalContext: contexts.get(n) ?? { keyFifths: 0, carried: [] },
      }
      if (n.printedAccidental !== undefined) note.printedAccidental = n.printedAccidental
      if (n.arpeggiate) note.arpeggiate = n.arpeggiate
      if (n.fingering !== undefined) note.fingering = n.fingering
      if (n.attack !== undefined) note.attack = n.attack
      notes.push(note)
      raw.push(n)
      extras.push({ clef: clefKeyOf(clefRaw?.clef ?? defaultClef(n.staff)), velocity })
    }
  }
  if (outOfRange > 0) {
    diag.warn(
      'pitch-out-of-range',
      `${outOfRange} note${outOfRange === 1 ? '' : 's'} lie outside the 88-key piano range.`,
    )
  }
  return { notes, raw, extras, unsupported, timing, clefsByStaff }
}
