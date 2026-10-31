import type { ClefKey } from '../model/score'
import type { Step } from '../music/pitch'
import { diatonicIndex, STEPS } from '../music/pitch'

/** A parsed clef key such as "G2", "F4", "C3" or "G2-8". */
export interface ParsedClef {
  readonly sign: 'G' | 'F' | 'C'
  /** Staff line the sign sits on, counted from the bottom (1–5). */
  readonly line: number
  /** Octaves the clef transposes the sounding pitch (-1 for 8vb). */
  readonly octaveChange: number
}

const CLEF_PATTERN = /^([GFC])([1-5])(?:([+-])(\d+))?$/u

export function parseClefKey(clefKey: ClefKey): ParsedClef | null {
  const match = CLEF_PATTERN.exec(clefKey)
  if (!match) return null
  const sign = match[1] as 'G' | 'F' | 'C'
  const line = Number(match[2])
  const magnitude = match[4] === undefined ? 0 : Number(match[4])
  // "-8" and "-15" name 8vb and 15mb; "-1" and "-2" are octave counts.
  const octaves = magnitude === 8 ? 1 : magnitude === 15 ? 2 : magnitude
  return { sign, line, octaveChange: match[3] === '-' ? -octaves : octaves }
}

const NAMED: Readonly<Record<string, readonly [name: string, qualifier: string]>> = {
  G2: ['Treble', 'G'],
  G1: ['French violin', 'G1'],
  F4: ['Bass', 'F'],
  F3: ['Baritone', 'F3'],
  F5: ['Subbass', 'F5'],
  C1: ['Soprano', 'C1'],
  C2: ['Mezzo-soprano', 'C2'],
  C3: ['Alto', 'C3'],
  C4: ['Tenor', 'C4'],
  C5: ['Baritone', 'C5'],
}

function octaveSuffix(change: number): string {
  if (change === 0) return ''
  if (Math.abs(change) >= 2) return change > 0 ? ' 15ma' : ' 15mb'
  return change > 0 ? ' 8va' : ' 8vb'
}

/** Short musical name of a clef: "Treble", "Bass", "Alto", "Treble 8vb". Unknown keys echo the key. */
export function clefShortName(clefKey: ClefKey): string {
  const clef = parseClefKey(clefKey)
  if (!clef) return clefKey
  const named = NAMED[`${clef.sign}${clef.line}`]
  const base = named ? named[0] : `${clef.sign}-clef line ${clef.line}`
  return `${base}${octaveSuffix(clef.octaveChange)}`
}

/** Label for the clef selector: "Treble (G)", "Bass (F)", "Alto (C3)". Unknown keys echo the key. */
export function clefDisplayName(clefKey: ClefKey): string {
  const clef = parseClefKey(clefKey)
  if (!clef) return clefKey
  const named = NAMED[`${clef.sign}${clef.line}`]
  return `${clefShortName(clefKey)} (${named ? named[1] : `${clef.sign}${clef.line}`})`
}

const CLEF_SIGN_NOTE: Readonly<Record<'G' | 'F' | 'C', { step: Step; octave: number }>> = {
  G: { step: 'G', octave: 4 },
  F: { step: 'F', octave: 3 },
  C: { step: 'C', octave: 4 },
}

/**
 * Diatonic index (see `diatonicIndex`) of the sounding pitch on the middle line of the clef's
 * staff. Used to choose representative sample pitches. Null for unrecognized clef keys.
 */
export function clefMiddleLineIndex(clefKey: ClefKey): number | null {
  const clef = parseClefKey(clefKey)
  if (!clef) return null
  const sign = CLEF_SIGN_NOTE[clef.sign]
  return diatonicIndex(sign) + 2 * (3 - clef.line) + 7 * clef.octaveChange
}

export function stepFromDiatonicIndex(index: number): { step: Step; octave: number } {
  const octave = Math.floor(index / 7)
  return { step: STEPS[index - octave * 7] ?? 'C', octave }
}
