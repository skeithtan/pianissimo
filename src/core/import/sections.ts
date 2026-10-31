/**
 * Section marks for the whole-piece overview (DECISIONS I12): rehearsal marks
 * (`<direction-type><rehearsal>`) and, when written like headings, standalone words above the
 * staff ("Verse", "Chorus", "Coda"). Display only: sections never change the performance.
 * Pure and worker-safe.
 */
import type { MeasureOccurrence, ScoreSection } from '../model/score'
import { classifyNavWords, isInstruction } from './navigation'
import type { RawSection } from './read/types'

/** Words that are tempo, expression or hand indications rather than headings. */
const NOT_A_HEADING =
  /\b(?:rit|ritard|ritardando|riten|ritenuto|rall|rallentando|accel|accelerando|stringendo|allarg|allargando|calando|smorzando|morendo|a\s+tempo|tempo\s+(?:i|primo|1)|meno|pi[uù]|mosso|grave|largo|larghetto|lento|adagio|adagietto|andante|andantino|moderato|allegretto|allegro|vivace|vivacissimo|presto|prestissimo|rubato|cresc|crescendo|dim|diminuendo|decresc|dolce|legato|staccato|marcato|espressivo|cantabile|sempre|simile|subito|poco|molto|pizz|arco|sost|ped|una\s+corda|tre\s+corde|loco|gliss|swing|straight)\b|^(?:[lr]\.?\s?h\.?|m\.?\s?[sdg]\.?)(?:\s|$)/i

export interface HeadingStyle {
  /** `<direction placement>`. */
  readonly placement?: string | undefined
  /** `font-style`, `font-weight` and `enclosure` of the words. */
  readonly fontStyle?: string | undefined
  readonly fontWeight?: string | undefined
  readonly enclosure?: string | undefined
}

/**
 * True when one direction's words read as a section heading: the direction holds only words,
 * placed above, set upright and emphasized (an explicit normal style, bold, or an enclosure),
 * starting with a capital or digit and containing a letter, and not an ottava, tempo,
 * expression, hand or D.C./D.S./Fine/To Coda instruction. A "Coda" heading counts.
 */
export function isSectionHeading(text: string, style: HeadingStyle): boolean {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length < 1 || t.length > 40) return false
  if (style.placement !== 'above') return false
  if (style.fontStyle === 'italic') return false
  const enclosed = style.enclosure !== undefined && style.enclosure !== 'none'
  if (!(enclosed || style.fontWeight === 'bold' || style.fontStyle === 'normal')) return false
  if (!/^[\p{Lu}\p{Nd}]/u.test(t) || !/\p{L}/u.test(t)) return false
  if (/^\d+\s?(?:va|vb|ma|mb|ve)\b/i.test(t)) return false
  if (NOT_A_HEADING.test(t)) return false
  return !classifyNavWords(t).kinds.some(isInstruction)
}

/**
 * Sections per performed bar: every occurrence of a marked source measure (each repeat pass
 * shows its mark again). One label per bar (rehearsal marks first, then document order);
 * sorted by bar.
 */
export function scoreSections(
  marks: readonly RawSection[],
  occurrences: readonly Pick<MeasureOccurrence, 'index' | 'sourceMeasure'>[],
): ScoreSection[] {
  if (marks.length === 0) return []
  const bySource = new Map<number, string>()
  const ordered = [...marks].sort((a, b) => (a.source === b.source ? 0 : a.source === 'rehearsal' ? -1 : 1))
  for (const mark of ordered) {
    const label = mark.label.replace(/\s+/g, ' ').trim()
    if (label && !bySource.has(mark.m)) bySource.set(mark.m, label)
  }
  const out: ScoreSection[] = []
  for (const o of occurrences) {
    const label = bySource.get(o.sourceMeasure)
    if (label !== undefined) out.push({ occ: o.index, label })
  }
  return out
}
