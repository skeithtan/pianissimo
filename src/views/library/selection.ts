/**
 * Score / movement and piano-part choice before building (spec "MusicXML score import": if an
 * import contains several scores or movements, let the user select one; DECISIONS I8: one part
 * with one or two staves, or two one-staff parts). Pure. The importer validates the selection
 * again in the worker (`validateSelection`); this mirror only keeps the button honest without
 * pulling the XML reader into the Library bundle.
 */
import type { CandidatePart, ImportCandidate } from '../../core/import/candidates'
import type { InspectResult } from '../../core/import/pipeline'

/** Parts with notes, in score order. */
export function playableParts(candidate: ImportCandidate): CandidatePart[] {
  return candidate.parts.filter((p) => p.notes > 0)
}

/**
 * Whether the user must choose: several scores, no suggested selection, or more playable
 * parts than the suggestion uses (a piano part next to other instruments).
 */
export function needsChoice(inspect: InspectResult): boolean {
  if (inspect.candidates.length !== 1) return true
  const only = inspect.candidates[0]!
  if (only.suggestedParts.length === 0) return true
  const playable = playableParts(only).map((p) => p.id)
  return playable.length !== only.suggestedParts.length || playable.some((id) => !only.suggestedParts.includes(id))
}

/** A readable reason the selection cannot be built, or null when it can. */
export function selectionProblem(candidate: ImportCandidate, partIds: readonly string[]): string | null {
  const chosen = candidate.parts.filter((p) => partIds.includes(p.id))
  if (chosen.length === 0) return 'Choose the piano part to practice.'
  if (chosen.length > 2) return 'Choose one two-staff piano part, or two one-staff parts (right hand, then left hand).'
  if (chosen.length === 2 && chosen.some((p) => p.staves !== 1)) {
    return 'Two parts can be combined only when each has a single staff (right hand above, left hand below).'
  }
  if (chosen.length === 1 && chosen[0]!.staves > 2) {
    return `“${chosen[0]!.name}” has ${chosen[0]!.staves} staves; only one- or two-staff piano parts are supported.`
  }
  if (chosen.every((p) => p.notes === 0)) return 'The chosen part has no notes to practice.'
  return null
}

/** Toggle a part in the selection, keeping score order. */
export function togglePart(candidate: ImportCandidate, partIds: readonly string[], id: string): string[] {
  const next = new Set(partIds)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return candidate.parts.filter((p) => next.has(p.id)).map((p) => p.id)
}

/** "Piano · 2 staves · 412 notes". */
export function describePart(part: CandidatePart): string {
  const bits = [`${part.staves} ${part.staves === 1 ? 'staff' : 'staves'}`, `${part.notes} notes`]
  if (part.instrument && part.instrument !== part.name) bits.unshift(part.instrument)
  return bits.join(' · ')
}

/** Heading for a candidate: movement title, title and subtitle as available. */
export function candidateTitle(candidate: ImportCandidate): string {
  const main =
    candidate.movementTitle && candidate.movementTitle !== candidate.title
      ? `${candidate.title} — ${candidate.movementTitle}`
      : candidate.title
  return candidate.subtitle ? `${main} (${candidate.subtitle})` : main
}
