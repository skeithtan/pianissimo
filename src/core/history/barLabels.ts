import type { MeasureOccurrence } from '../model/score'

export interface BarLabeler {
  /** Printed measure number with its pass when the bar repeats: "12" or "12 (pass 2)". */
  label(occ: number): string
  number(occ: number): string
  pass(occ: number): number
  /** "bar 12" or "bars 12–14" (en dash) for an inclusive occurrence range. */
  range(fromOcc: number, toOcc: number): string
}

/**
 * Labels occurrences the way the strip draws them (DECISIONS M5): the printed number, plus
 * "(pass N)" for repeat passes after the first. Unknown occurrences fall back to their
 * 1-based performance index so a stale suggestion never throws.
 */
export function createBarLabeler(occurrences: readonly MeasureOccurrence[]): BarLabeler {
  const numberOf = (occ: number): string => occurrences[occ]?.number ?? String(occ + 1)
  const passOf = (occ: number): number => occurrences[occ]?.pass ?? 1
  const label = (occ: number): string => {
    const pass = passOf(occ)
    return pass > 1 ? `${numberOf(occ)} (pass ${pass})` : numberOf(occ)
  }
  return {
    label,
    number: numberOf,
    pass: passOf,
    range: (fromOcc, toOcc) => (fromOcc === toOcc ? `bar ${label(fromOcc)}` : `bars ${label(fromOcc)}–${label(toOcc)}`),
  }
}
