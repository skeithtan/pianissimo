/**
 * Hand assignment (spec: "Confirm hand assignments from staff and voice information. Do not
 * infer hands from pitch, a middle-C split, or clef alone. Cross-staff passages require an
 * explicit assignment"; DECISIONS M2).
 *
 * MusicXML has no hand element, but a voice is one musical line and a line belongs to one hand;
 * cross-staff notation only moves a few of its notes to the other staff for printing. So hands
 * are assigned per voice (`partId:voice`): a voice goes to the hand of its *home staff* — the
 * staff holding most of its notes (the top selected staff is the right hand, the staff below the
 * left hand). The assignment is explicit (recorded per voice, shown in the import summary,
 * changeable there) without a confirmation step.
 *
 * A voice is *ambiguous* (`ambiguousVoices`, confirmation required before scored practice) only
 * when the file genuinely does not say which hand plays it: it has notes on more than one staff,
 * the part's voice numbering does not follow the staff convention, and the minority staff holds
 * a third or more of its notes (`SPLIT_SHARE`). The convention — voices 1–4 belong to a part's
 * first staff and 5–8 to its second (MuseScore, Sibelius, Finale, LilyPond exports) — settles a
 * cross-staff voice when every numbered voice of that part has its home staff where the
 * convention puts it; a part numbered otherwise (sequential voices, as Dorico writes) falls back
 * to the share rule. The convention never makes a single-staff voice ambiguous.
 */
import type {
  Hand,
  HandAssignment,
  PartRef,
  PerformedNote,
  ScoreModel,
  SourceNote,
  StaffDef,
  VoiceDef,
  VoiceKey,
} from '../model/score'
import { staffHand } from './performance'

/** Minority-staff share (of the voice's notes) from which a cross-staff voice counts as split. */
export const SPLIT_SHARE = 1 / 3

export function voiceKey(partId: string, voice: string): VoiceKey {
  return `${partId}:${voice}`
}

/** Voices in order of first appearance, with note counts per global staff. */
export function collectVoices(sourceNotes: readonly SourceNote[]): VoiceDef[] {
  const byKey = new Map<VoiceKey, { partId: string; voice: string; counts: Record<number, number> }>()
  for (const n of sourceNotes) {
    const k = voiceKey(n.partId, n.voice)
    let v = byKey.get(k)
    if (!v) byKey.set(k, (v = { partId: n.partId, voice: n.voice, counts: {} }))
    v.counts[n.staff] = (v.counts[n.staff] ?? 0) + 1
  }
  return [...byKey].map(([k, v]) => ({ key: k, partId: v.partId, voice: v.voice, notesPerStaff: v.counts }))
}

/** Staff counts sorted most-used first (ties: the upper staff), zero counts dropped. */
export function staffUse(v: VoiceDef): (readonly [staff: number, count: number])[] {
  return Object.entries(v.notesPerStaff)
    .map(([s, c]) => [Number(s), c] as const)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
}

/** The staff holding most of the voice's notes (the upper one on a tie). */
export function homeStaff(v: VoiceDef): number {
  return staffUse(v)[0]?.[0] ?? 0
}

/** True when the voice has notes on more than one staff. */
export function isCrossStaff(v: VoiceDef): boolean {
  return staffUse(v).length > 1
}

/**
 * The global staff the voice-number convention puts a voice on (voices 1–4 → the part's first
 * staff, 5–8 → its second), or undefined when the convention cannot apply: a non-numeric or
 * out-of-range voice, or a part without exactly two staves.
 */
export function conventionStaff(
  v: VoiceDef,
  parts: readonly PartRef[],
  staves: readonly StaffDef[],
): number | undefined {
  const part = parts.find((p) => p.id === v.partId)
  if (!part || part.staffCount !== 2) return undefined
  const n = Number(v.voice)
  if (!Number.isInteger(n) || n < 1 || n > 8) return undefined
  const staffNumber = n <= 4 ? 1 : 2
  return staves.find((s) => s.partId === v.partId && s.staffNumber === staffNumber)?.index
}

/**
 * Parts whose numbered voices all sit where the convention puts them (by home staff), so the
 * convention can be trusted to settle that part's cross-staff voices.
 */
export function conventionalParts(
  voices: readonly VoiceDef[],
  parts: readonly PartRef[],
  staves: readonly StaffDef[],
): ReadonlySet<string> {
  const ok = new Set<string>()
  for (const p of parts) {
    const own = voices.filter((v) => v.partId === p.id)
    if (own.length === 0) continue
    const verdicts = own.map((v) => {
      const expected = conventionStaff(v, parts, staves)
      return expected === undefined ? undefined : expected === homeStaff(v)
    })
    if (verdicts.every((x) => x === true)) ok.add(p.id)
  }
  return ok
}

/** Proposed assignment (M2): the home staff decides; only genuinely split voices are ambiguous. */
export function proposeHands(
  voices: readonly VoiceDef[],
  parts: readonly PartRef[] = [],
  staves: readonly StaffDef[] = [],
): HandAssignment {
  const byVoice: Record<VoiceKey, Hand> = {}
  const ambiguousVoices: VoiceKey[] = []
  const conventional = conventionalParts(voices, parts, staves)
  for (const v of voices) {
    const use = staffUse(v)
    byVoice[v.key] = staffHand(use[0]?.[0] ?? 0)
    if (use.length < 2 || conventional.has(v.partId)) continue
    const total = use.reduce((sum, [, c]) => sum + c, 0)
    const minority = total - (use[0]?.[1] ?? 0)
    if (minority >= total * SPLIT_SHARE) ambiguousVoices.push(v.key)
  }
  return { byVoice, ambiguousVoices, confirmed: ambiguousVoices.length === 0 }
}

/**
 * Apply a user-chosen hand assignment. `byVoice` may cover only some voices; the others keep
 * their current hand. Every performed note's `hand` follows its voice, and the assignment is
 * marked confirmed (ambiguous voices remain listed so the summary can show what was resolved).
 * Throws on unknown voices or invalid hands.
 */
export function applyHandAssignment(model: ScoreModel, byVoice: Readonly<Record<VoiceKey, Hand>>): ScoreModel {
  const known = new Set(model.voices.map((v) => v.key))
  for (const [k, h] of Object.entries(byVoice)) {
    if (!known.has(k)) throw new RangeError(`Unknown voice “${k}” in hand assignment`)
    if (h !== 'L' && h !== 'R') throw new RangeError(`Invalid hand “${String(h)}” for voice “${k}”`)
  }
  const merged: Record<VoiceKey, Hand> = { ...model.hands.byVoice, ...byVoice }
  const notes: PerformedNote[] = model.notes.map((n) => {
    const hand = merged[voiceKey(n.partId, n.voice)] ?? n.hand
    return hand === n.hand ? n : { ...n, hand }
  })
  return {
    ...model,
    hands: { byVoice: merged, ambiguousVoices: model.hands.ambiguousVoices, confirmed: true },
    notes,
    diagnostics: model.diagnostics.filter((d) => d.code !== 'hand-ambiguous'),
  }
}
