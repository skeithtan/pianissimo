import { describe, expect, it } from 'vitest'
import type { AccidentalContext } from '../model/score'
import type { NamingSettings } from '../model/settings'
import { DEFAULT_SETTINGS } from '../model/settings'
import type { Step } from '../music/pitch'
import { spellingToMidi } from '../music/pitch'
import type { LabelableNote } from './label'
import { labelFor, labelForMidi, labelText, maxLabelWidthChars, stepName } from './label'

const CLEAN: AccidentalContext = { keyFifths: 0, carried: [] }

function note(
  step: Step,
  alter: number,
  octave: number,
  context: AccidentalContext = CLEAN,
  ottavaShift = 0,
): LabelableNote {
  return { sounding: { step, alter, octave }, ottavaShift, accidentalContext: context }
}

const naming = (overrides: Partial<NamingSettings> = {}): NamingSettings => ({
  ...DEFAULT_SETTINGS.naming,
  ...overrides,
})
const ON = { alwaysShowEffectiveAccidentals: true } as const
const OFF = { alwaysShowEffectiveAccidentals: false } as const

/** [simplify off, simplify on] for effective accidentals ON (the spec's explicit hints). */
describe('spec table: explicit hints (effective accidentals on)', () => {
  const rows: Array<[string, LabelableNote, string, string]> = [
    ['C4 sharpened by the key signature', note('C', 1, 4, { keyFifths: 2, carried: [] }), 'C♯4', 'C♯4'],
    ['B4 flattened by the key signature', note('B', -1, 4, { keyFifths: -1, carried: [] }), 'B♭4', 'B♭4'],
    ['B♯4', note('B', 1, 4), 'B♯4', 'C5'],
    ['C♭4', note('C', -1, 4), 'C♭4', 'B3'],
    ['E♯4', note('E', 1, 4), 'E♯4', 'F4'],
    ['F♭4', note('F', -1, 4), 'F♭4', 'E4'],
    ['F𝄪4', note('F', 2, 4), 'F𝄪4', 'G4'],
    ['B𝄫4', note('B', -2, 4), 'B𝄫4', 'A4'],
  ]

  it.each(rows)('%s', (_name, n, off, on) => {
    expect(labelText(n, naming({ ...ON, simplifyEnharmonics: false }))).toBe(off)
    expect(labelText(n, naming({ ...ON, simplifyEnharmonics: true }))).toBe(on)
  })
})

describe('simplification with a recalculated octave and direction', () => {
  const simplified = naming({ ...ON, simplifyEnharmonics: true })

  it.each([
    [note('C', 2, 4), 'D4'],
    [note('D', 2, 4), 'E4'],
    [note('G', 2, 4), 'A4'],
    [note('E', -2, 4), 'D4'],
    [note('A', -2, 4), 'G4'],
    [note('C', -2, 4), 'B♭3'],
    [note('F', -2, 4), 'E♭4'],
    [note('E', 2, 4), 'F♯4'],
    [note('B', 2, 4), 'C♯5'],
  ])('%j', (n, expected) => {
    expect(labelText(n, simplified)).toBe(expected)
  })

  it('keeps ordinary single accidentals', () => {
    expect(labelText(note('E', -1, 4), simplified)).toBe('E♭4')
    expect(labelText(note('C', 1, 4), simplified)).toBe('C♯4')
    expect(labelText(note('A', -1, 3), simplified)).toBe('A♭3')
  })

  it('preserves the original spelling when simplification is off', () => {
    const plain = naming({ ...ON, simplifyEnharmonics: false })
    expect(labelText(note('E', -1, 4), plain)).toBe('E♭4')
    expect(labelText(note('D', -2, 4), plain)).toBe('D𝄫4')
    expect(labelText(note('G', 2, 4), plain)).toBe('G𝄪4')
  })
})

describe('four preference combinations', () => {
  const cSharpMajor: AccidentalContext = { keyFifths: 7, carried: [] }
  const bSharp4 = note('B', 1, 4, cSharpMajor)

  it('B♯4 in C♯ major across all four combinations', () => {
    expect(labelText(bSharp4, naming({ ...ON, simplifyEnharmonics: false }))).toBe('B♯4')
    expect(labelText(bSharp4, naming({ ...ON, simplifyEnharmonics: true }))).toBe('C5')
    // The key signature already makes B sharp, so the plain name is the score's own spelling.
    expect(labelText(bSharp4, naming({ ...OFF, simplifyEnharmonics: false }))).toBe('B4')
    // Written C5 is C♯ in this key, so the respelled natural needs its sign: C♮5, not an ambiguous C5.
    expect(labelText(bSharp4, naming({ ...OFF, simplifyEnharmonics: true }))).toBe('C♮5')
  })

  it('B♯4 in C major is unambiguous in every combination', () => {
    const n = note('B', 1, 4)
    expect(labelText(n, naming({ ...ON, simplifyEnharmonics: false }))).toBe('B♯4')
    expect(labelText(n, naming({ ...OFF, simplifyEnharmonics: false }))).toBe('B♯4')
    expect(labelText(n, naming({ ...ON, simplifyEnharmonics: true }))).toBe('C5')
    expect(labelText(n, naming({ ...OFF, simplifyEnharmonics: true }))).toBe('C5')
  })

  it('C♭4 in G♭ major (six flats): the key makes C flat, so contextual simplified B3 needs a natural', () => {
    const gFlatMajor: AccidentalContext = { keyFifths: -6, carried: [] }
    const n = note('C', -1, 4, gFlatMajor)
    expect(labelText(n, naming({ ...OFF, simplifyEnharmonics: false }))).toBe('C4')
    expect(labelText(n, naming({ ...ON, simplifyEnharmonics: true }))).toBe('B3')
    // B is flat in this key too, so a bare B3 would read as B♭3; the natural must stay.
    expect(labelText(n, naming({ ...OFF, simplifyEnharmonics: true }))).toBe('B♮3')
  })
})

describe('key signature and carried accidentals', () => {
  it('names the actual pitch when the setting is on, even with no printed accidental', () => {
    const dMajor: AccidentalContext = { keyFifths: 2, carried: [] }
    expect(labelText(note('C', 1, 5, dMajor), naming(ON))).toBe('C♯5')
    expect(labelText(note('F', 1, 3, dMajor), naming(ON))).toBe('F♯3')
    expect(labelText(note('D', 0, 4, dMajor), naming(ON))).toBe('D4')
  })

  it('omits accidentals implied by the key when the setting is off', () => {
    const dMajor: AccidentalContext = { keyFifths: 2, carried: [] }
    expect(labelText(note('C', 1, 5, dMajor), naming(OFF))).toBe('C5')
    expect(labelText(note('F', 1, 3, dMajor), naming(OFF))).toBe('F3')
    const fMajor: AccidentalContext = { keyFifths: -1, carried: [] }
    expect(labelText(note('B', -1, 4, fMajor), naming(OFF))).toBe('B4')
  })

  it('keeps explicit changes visible when the setting is off', () => {
    const dMajor: AccidentalContext = { keyFifths: 2, carried: [] }
    expect(labelText(note('G', 1, 4, dMajor), naming(OFF))).toBe('G♯4')
    expect(labelText(note('F', 0, 4, dMajor), naming(OFF))).toBe('F♮4')
    expect(labelText(note('C', -1, 4, dMajor), naming(OFF))).toBe('C♭4')
    expect(labelText(note('F', 2, 4, dMajor), naming(OFF))).toBe('F𝄪4')
  })

  it('shows a natural for a cancellation with the setting on or off, never for an unaltered note', () => {
    const gMajor: AccidentalContext = { keyFifths: 1, carried: [] }
    expect(labelText(note('F', 0, 4, gMajor), naming(ON))).toBe('F♮4')
    expect(labelText(note('F', 0, 4, gMajor), naming(OFF))).toBe('F♮4')
    expect(labelText(note('G', 0, 4, gMajor), naming(ON))).toBe('G4')
    expect(labelText(note('G', 0, 4, gMajor), naming(OFF))).toBe('G4')
    expect(labelText(note('F', 0, 4), naming(ON))).toBe('F4')
  })

  it('handles carried accidentals within a measure', () => {
    const afterSharp: AccidentalContext = { keyFifths: 0, carried: [['F', 4, 1]] }
    // Repeated F♯ with no printed accidental: redundant when off, explicit when on.
    expect(labelText(note('F', 1, 4, afterSharp), naming(OFF))).toBe('F4')
    expect(labelText(note('F', 1, 4, afterSharp), naming(ON))).toBe('F♯4')
    // Natural sign canceling the carried sharp.
    expect(labelText(note('F', 0, 4, afterSharp), naming(OFF))).toBe('F♮4')
    expect(labelText(note('F', 0, 4, afterSharp), naming(ON))).toBe('F♮4')
    // A different octave is not affected.
    expect(labelText(note('F', 0, 5, afterSharp), naming(OFF))).toBe('F5')
    expect(labelText(note('F', 1, 5, afterSharp), naming(OFF))).toBe('F♯5')
  })

  it('lets a carried natural cancel the key signature, without applying the key twice', () => {
    const canceled: AccidentalContext = { keyFifths: 1, carried: [['F', 4, 0]] }
    // Later F with no accidental sounds natural: it is redundant when off and plain F when on.
    expect(labelText(note('F', 0, 4, canceled), naming(OFF))).toBe('F4')
    expect(labelText(note('F', 0, 4, canceled), naming(ON))).toBe('F4')
    // A different octave still has the key signature's sharp.
    expect(labelText(note('F', 1, 5, canceled), naming(OFF))).toBe('F5')
  })

  it('shows a flat that changes a carried sharp', () => {
    const ctx: AccidentalContext = { keyFifths: 0, carried: [['B', 3, 1]] }
    expect(labelText(note('B', -1, 3, ctx), naming(OFF))).toBe('B♭3')
  })
})

describe('ottava', () => {
  it('labels the sounding pitch: written C4 under 8va is C5', () => {
    expect(labelText(note('C', 0, 5, CLEAN, 1), naming())).toBe('C5')
    expect(labelFor(note('C', 0, 5, CLEAN, 1), naming()).octave).toBe(5)
  })

  it('applies displacement once for 8vb and 15ma', () => {
    expect(labelText(note('C', 0, 3, CLEAN, -1), naming())).toBe('C3')
    expect(labelText(note('G', 0, 6, CLEAN, 2), naming())).toBe('G6')
  })

  it('keys carried accidentals by the written octave', () => {
    // Sounding F♯5 under 8va is written F♯4; the carried sharp is on written F4.
    const carriedAtWritten: AccidentalContext = { keyFifths: 0, carried: [['F', 4, 1]] }
    expect(labelText(note('F', 1, 5, carriedAtWritten, 1), naming(OFF))).toBe('F5')
    const carriedAtSounding: AccidentalContext = { keyFifths: 0, carried: [['F', 5, 1]] }
    expect(labelText(note('F', 1, 5, carriedAtSounding, 1), naming(OFF))).toBe('F♯5')
  })

  it('uses the written octave for the respelled name too', () => {
    // Sounding B♯5 (under 8va, written B♯4) simplifies to C6 (written C5, sharpened by the key).
    const ctx: AccidentalContext = { keyFifths: 7, carried: [] }
    expect(labelText(note('B', 1, 5, ctx, 1), naming({ ...OFF, simplifyEnharmonics: true }))).toBe('C♮6')
    expect(labelText(note('B', 1, 5, ctx, 1), naming({ ...ON, simplifyEnharmonics: true }))).toBe('C6')
  })
})

describe('fixed do', () => {
  const fixed = (overrides: Partial<NamingSettings> = {}) => naming({ system: 'fixed-do', ...overrides })

  it('names the steps do re mi fa sol la si', () => {
    const steps: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
    expect(steps.map((s) => stepName(s, fixed()))).toEqual(['do', 're', 'mi', 'fa', 'sol', 'la', 'si'])
    expect(steps.map((s) => stepName(s, fixed({ seventh: 'ti' })))).toEqual(['do', 're', 'mi', 'fa', 'sol', 'la', 'ti'])
  })

  it('applies the same accidental policy before converting', () => {
    expect(labelText(note('C', 1, 4), fixed())).toBe('do♯4')
    expect(labelText(note('B', 1, 4), fixed({ simplifyEnharmonics: true }))).toBe('do5')
    expect(labelText(note('B', 1, 4), fixed())).toBe('si♯4')
    expect(labelText(note('C', -1, 4), fixed({ simplifyEnharmonics: true }))).toBe('si3')
    expect(labelText(note('B', -1, 3), fixed())).toBe('si♭3')
    expect(labelText(note('B', -1, 3), fixed({ seventh: 'ti' }))).toBe('ti♭3')
    expect(labelText(note('G', 0, 4), fixed())).toBe('sol4')
  })

  it('keeps the C♮5 contextual example in fixed do', () => {
    const cSharpMajor: AccidentalContext = { keyFifths: 7, carried: [] }
    const n = note('B', 1, 4, cSharpMajor)
    expect(labelText(n, fixed({ ...OFF, simplifyEnharmonics: true }))).toBe('do♮5')
    expect(labelText(n, fixed({ ...ON, simplifyEnharmonics: true }))).toBe('do5')
  })

  it('hides the octave independently of the system', () => {
    expect(labelText(note('C', 1, 4), fixed({ showOctave: false }))).toBe('do♯')
    expect(labelText(note('B', 0, 4), fixed({ showOctave: false, seventh: 'ti' }))).toBe('ti')
  })
})

describe('octave display and structure', () => {
  it('uses middle C = C4 / do4 and honors showOctave', () => {
    expect(labelText(note('C', 0, 4), naming())).toBe('C4')
    expect(labelText(note('C', 0, 4), naming({ system: 'fixed-do' }))).toBe('do4')
    expect(labelText(note('C', 1, 4), naming({ showOctave: false }))).toBe('C♯')
  })

  it('recalculates the octave after respelling when octaves are shown', () => {
    const simplified = naming({ simplifyEnharmonics: true })
    expect(labelFor(note('B', 1, 4), simplified).octave).toBe(5)
    expect(labelFor(note('C', -1, 4), simplified).octave).toBe(3)
    expect(labelFor(note('B', 1, 4), { ...simplified, showOctave: false }).octave).toBeNull()
  })

  it('returns structured parts', () => {
    expect(labelFor(note('C', 1, 4), naming())).toEqual({ name: 'C', accidental: '♯', octave: 4, text: 'C♯4' })
    expect(labelFor(note('G', 0, 3), naming({ showOctave: false }))).toEqual({
      name: 'G',
      accidental: '',
      octave: null,
      text: 'G',
    })
  })

  it('names every piano key from the sounding MIDI number consistently', () => {
    for (let midi = 21; midi <= 108; midi++) {
      const label = labelForMidi(midi, naming())
      const match = /^([A-G])([♯]?)(\d)$/u.exec(label.text)
      expect(match, label.text).not.toBeNull()
    }
    expect(labelForMidi(60, naming()).text).toBe('C4')
    expect(labelForMidi(61, naming()).text).toBe('C♯4')
    expect(labelForMidi(61, naming(), 'flat').text).toBe('D♭4')
    expect(labelForMidi(60, naming({ system: 'fixed-do' })).text).toBe('do4')
    expect(labelForMidi(24, naming({ showOctave: true })).text).toBe('C1')
    expect(labelForMidi(108, naming()).text).toBe('C8')
  })

  it('never changes the pitch', () => {
    const n = note('B', 1, 4)
    const before = spellingToMidi(n.sounding)
    labelFor(n, naming({ simplifyEnharmonics: true }))
    expect(spellingToMidi(n.sounding)).toBe(before)
  })
})

describe('maxLabelWidthChars', () => {
  it('reserves name + accidental + octave', () => {
    expect(maxLabelWidthChars(naming())).toBe(3)
    expect(maxLabelWidthChars(naming({ showOctave: false }))).toBe(2)
    expect(maxLabelWidthChars(naming({ system: 'fixed-do' }))).toBe(5)
    expect(maxLabelWidthChars(naming({ system: 'fixed-do', showOctave: false }))).toBe(4)
  })

  it('covers every label the policy can produce', () => {
    for (const system of ['letter', 'fixed-do'] as const) {
      const settings = naming({ system, showOctave: true, simplifyEnharmonics: false })
      const limit = maxLabelWidthChars(settings)
      for (const step of ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const) {
        for (const alter of [-2, -1, 0, 1, 2]) {
          const text = labelText(note(step, alter, 4), settings)
          expect(Array.from(text).length).toBeLessThanOrEqual(limit)
        }
      }
    }
  })
})
