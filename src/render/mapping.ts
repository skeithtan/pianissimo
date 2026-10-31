/**
 * Note ↔ graphic mapping (spec "Common score model and import pipeline": keep source, performed
 * and graphic identities separate and verify the note-to-graphic mapping for the renderer).
 *
 * Engraver-neutral: the adapter extracts `GraphicNote`s (one per drawn notehead) and this module
 * assigns each `PerformedNote.index` a graphic by (occurrence, staff, voice, onset in measure,
 * sounding MIDI, grace). Unmatched notes are retried with relaxed keys (voice, then staff
 * disagreements, then a fractional microtone pitch are counted), and a note whose unison twin in
 * another voice already owns the only drawn notehead shares it (one label per shared notehead).
 */
import { key as ratKey, toNumber, type Rational } from '../core/music/rational'
import type { Box, MappingNote, MappingReport, RenderInput } from './types'

export interface GraphicNote {
  /** Renderer-local id (index into the extracted list). */
  readonly id: number
  readonly occ: number
  readonly staff: number
  readonly voice: string
  readonly onset: Rational
  /** Sounding MIDI pitch as the engraver understood it. */
  readonly midi: number
  readonly grace: boolean
  readonly head: Box
  /** Onset anchor x (staff-entry x). */
  readonly x: number
  /** Engraver graphic id (e.g. the VexFlow stavenote id). */
  readonly graphic: string
}

export interface NoteMapping {
  /** By `PerformedNote.index`: graphic id, or -1 when unmapped. */
  readonly graphicOf: readonly number[]
  /** Label units: notes drawn by one notehead (several only for a shared notehead), sorted. */
  readonly units: readonly (readonly number[])[]
  /** By `PerformedNote.index`: label unit id, or -1 when unmapped. */
  readonly unitOf: readonly number[]
  readonly report: Omit<MappingReport, 'ottavasMapped' | 'ottavasUnmapped'>
}

type Keyer = (occ: number, staff: number, voice: string, onset: Rational, midi: number, grace: boolean) => string

/** Onsets compare at 1e-6 whole notes: engravers may store tuplet positions approximately. */
const at = (t: Rational): number => Math.round(toNumber(t) * 1e6)
const strict: Keyer = (o, s, v, t, m, g) => `${o}|${s}|${v}|${at(t)}|${m}|${g ? 1 : 0}`
const noVoice: Keyer = (o, s, _v, t, m, g) => `${o}|${s}|${at(t)}|${m}|${g ? 1 : 0}`
const noStaff: Keyer = (o, _s, v, t, m, g) => `${o}|${v}|${at(t)}|${m}|${g ? 1 : 0}`
const loose: Keyer = (o, _s, _v, t, m, g) => `${o}|${at(t)}|${m}|${g ? 1 : 0}`

/** Two noteheads closer than this (layout px, both axes) on one staff are one graphical notehead. */
const SAME_HEAD_PX = 1.5

export function describeGraphic(g: GraphicNote): string {
  return `${g.occ}:${g.staff}:${g.voice}:${ratKey(g.onset)}:${g.midi}`
}

export function mapNotes(notes: RenderInput['notes'], graphics: readonly GraphicNote[]): NoteMapping {
  const graphicOf = new Array<number>(notes.length).fill(-1)
  const used = new Uint8Array(graphics.length)
  let relaxed = 0

  const index = (k: Keyer): Map<string, number[]> => {
    const m = new Map<string, number[]>()
    for (const g of graphics) {
      const id = k(g.occ, g.staff, g.voice, g.onset, g.midi, g.grace)
      const list = m.get(id)
      if (list) list.push(g.id)
      else m.set(id, [g.id])
    }
    return m
  }
  const noteKey = (k: Keyer, n: MappingNote): string => k(n.occ, n.staff, n.voice, n.onsetInMeasure, n.midi, n.grace)

  const passes: readonly Keyer[] = [strict, noVoice, noStaff, loose]
  passes.forEach((keyer, pass) => {
    const byKey = index(keyer)
    for (const n of notes) {
      if (graphicOf[n.index] !== -1) continue
      const candidates = byKey.get(noteKey(keyer, n))
      const free = candidates?.find((id) => used[id] === 0)
      if (free === undefined) continue
      used[free] = 1
      graphicOf[n.index] = free
      if (pass > 0) relaxed++
    }
  })

  // Microtones (unsupported content, still displayed): the engraver's pitch may be fractional.
  const byPosition = new Map<string, number[]>()
  for (const g of graphics) {
    const k = `${g.occ}|${g.staff}|${at(g.onset)}|${g.grace ? 1 : 0}`
    const list = byPosition.get(k)
    if (list) list.push(g.id)
    else byPosition.set(k, [g.id])
  }
  for (const n of notes) {
    if (graphicOf[n.index] !== -1) continue
    const near = byPosition
      .get(`${n.occ}|${n.staff}|${at(n.onsetInMeasure)}|${n.grace ? 1 : 0}`)
      ?.find(
        (id) =>
          used[id] === 0 && Math.abs(graphics[id]!.midi - n.midi) < 1 && !Number.isInteger(graphics[id]!.midi - n.midi),
      )
    if (near === undefined) continue
    used[near] = 1
    graphicOf[n.index] = near
    relaxed++
  }

  // A unison in two voices may be engraved as one notehead: share the graphic already taken.
  const byNoVoice = index(noVoice)
  for (const n of notes) {
    if (graphicOf[n.index] !== -1) continue
    const shared = byNoVoice.get(noteKey(noVoice, n))?.[0]
    if (shared !== undefined) graphicOf[n.index] = shared
  }

  const { units, unitOf } = labelUnits(notes, graphics, graphicOf)
  const unmappedNotes = notes.filter((n) => graphicOf[n.index] === -1).map((n) => n.index)
  const unmappedGraphics = graphics.filter((g) => used[g.id] === 0).map(describeGraphic)
  return {
    graphicOf,
    units,
    unitOf,
    report: {
      modelNotes: notes.length,
      graphicalNotes: graphics.length,
      mapped: notes.length - unmappedNotes.length,
      unmappedNotes,
      unmappedGraphics,
      relaxedMatches: relaxed,
      sharedHeads: units.filter((u) => u.length > 1).length,
    },
  }
}

/** Group mapped notes by graphical notehead: same graphic, or coincident heads on one staff. */
function labelUnits(
  notes: RenderInput['notes'],
  graphics: readonly GraphicNote[],
  graphicOf: readonly number[],
): { units: number[][]; unitOf: number[] } {
  const unitOf = new Array<number>(notes.length).fill(-1)
  const units: number[][] = []
  const unitHeads: { staff: number; occ: number; head: Box }[] = []
  const byGraphic = new Map<number, number>()
  const nearby = new Map<string, number[]>()

  // Cue notes are never labeled (I13): they stay mapped but form no unit.
  const sorted = notes.filter((n) => graphicOf[n.index]! >= 0 && !n.cue).sort((a, b) => a.index - b.index)
  for (const n of sorted) {
    const gid = graphicOf[n.index]!
    const g = graphics[gid]!
    let unit = byGraphic.get(gid)
    if (unit === undefined) {
      const cellKey = `${g.occ}|${g.staff}|${Math.round(g.head.x / 4)}|${Math.round(g.head.y / 4)}`
      unit = findCoincident(g, nearby, unitHeads)
      if (unit === undefined) {
        unit = units.length
        units.push([])
        unitHeads.push({ staff: g.staff, occ: g.occ, head: g.head })
      }
      const list = nearby.get(cellKey)
      if (list) list.push(unit)
      else nearby.set(cellKey, [unit])
      byGraphic.set(gid, unit)
    }
    units[unit]!.push(n.index)
    unitOf[n.index] = unit
  }
  return { units, unitOf }
}

function findCoincident(
  g: GraphicNote,
  nearby: Map<string, number[]>,
  unitHeads: readonly { staff: number; occ: number; head: Box }[],
): number | undefined {
  const cx = Math.round(g.head.x / 4)
  const cy = Math.round(g.head.y / 4)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const u of nearby.get(`${g.occ}|${g.staff}|${cx + dx}|${cy + dy}`) ?? []) {
        const h = unitHeads[u]!
        if (
          h.staff === g.staff &&
          Math.abs(h.head.x - g.head.x) < SAME_HEAD_PX &&
          Math.abs(h.head.y - g.head.y) < SAME_HEAD_PX
        ) {
          return u
        }
      }
    }
  }
  return undefined
}
