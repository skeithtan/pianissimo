import { describe, expect, it } from 'vitest'
import type { ClefLabelRule, PersistentLabelSettings } from '../model/settings'
import { DISABLED_RULE, TREBLE_PRESET } from '../model/settings'
import type { Spelling, Step } from '../music/pitch'
import { spellingToMidi } from '../music/pitch'
import { isPersistentLabelVisible, ruleForClef, ruleLabelsMidi } from './eligibility'

const sp = (step: Step, alter: number, octave: number): Spelling => ({ step, alter, octave })
const midiOf = (step: Step, alter: number, octave: number) => spellingToMidi(sp(step, alter, octave))

const conditional = (rules: PersistentLabelSettings['rules']): PersistentLabelSettings => ({
  mode: 'conditional',
  rules,
  tiedContinuations: false,
})
const treble = conditional({ G2: TREBLE_PRESET, F4: DISABLED_RULE })

const visible = (midi: number, clef: string, labels: PersistentLabelSettings, tieContinuation = false) =>
  isPersistentLabelVisible({ midi, clef, tieContinuation }, labels)

describe('spec acceptance: G-clef below C4 or above C5', () => {
  it('labels B3 and C♯5', () => {
    expect(visible(midiOf('B', 0, 3), 'G2', treble)).toBe(true)
    expect(visible(midiOf('C', 1, 5), 'G2', treble)).toBe(true)
  })

  it('leaves C4 through C5, including both boundaries, unlabeled', () => {
    for (const [step, octave] of [
      ['C', 4],
      ['D', 4],
      ['E', 4],
      ['G', 4],
      ['B', 4],
      ['C', 5],
    ] as const) {
      expect(visible(midiOf(step, 0, octave), 'G2', treble), `${step}${octave}`).toBe(false)
    }
    for (let midi = 60; midi <= 72; midi++) expect(visible(midi, 'G2', treble)).toBe(false)
  })

  it('qualifies written C5 under 8va through its sounding C6', () => {
    // The model's midi is the sounding pitch: written C5 + 8va sounds C6.
    expect(visible(midiOf('C', 0, 6), 'G2', treble)).toBe(true)
    // The same written C5 with no ottava does not qualify.
    expect(visible(midiOf('C', 0, 5), 'G2', treble)).toBe(false)
  })
})

describe('modes', () => {
  it('off labels nothing', () => {
    expect(visible(40, 'G2', { mode: 'off', rules: { G2: TREBLE_PRESET }, tiedContinuations: true })).toBe(false)
  })

  it('all labels every pitched note regardless of rules, clef or range', () => {
    const all: PersistentLabelSettings = { mode: 'all', rules: {}, tiedContinuations: false }
    for (const midi of [21, 60, 72, 108]) expect(visible(midi, 'G2', all)).toBe(true)
    expect(visible(60, 'C3', all)).toBe(true)
  })
})

describe('tie continuations (U69)', () => {
  const all: PersistentLabelSettings = { mode: 'all', rules: {}, tiedContinuations: false }

  it('are not labeled by default, in All notes or Conditional', () => {
    expect(visible(60, 'G2', all, true)).toBe(false)
    expect(visible(midiOf('B', 0, 3), 'G2', treble, true)).toBe(false)
    // The tie's first note keeps its label.
    expect(visible(60, 'G2', all)).toBe(true)
  })

  it('are labeled like any other note with the setting on', () => {
    expect(visible(60, 'G2', { ...all, tiedContinuations: true }, true)).toBe(true)
    const tiedTreble = { ...treble, tiedContinuations: true }
    expect(visible(midiOf('B', 0, 3), 'G2', tiedTreble, true)).toBe(true)
    expect(visible(midiOf('C', 0, 4), 'G2', tiedTreble, true)).toBe(false)
  })
})

describe('enabled conditions combine with OR; each can be used alone', () => {
  const only = (rule: ClefLabelRule) => conditional({ G2: rule })
  const belowOnly = only({ below: TREBLE_PRESET.below, above: { enabled: false, threshold: sp('C', 0, 5) } })
  const aboveOnly = only({ below: { enabled: false, threshold: sp('C', 0, 4) }, above: TREBLE_PRESET.above })

  it('show-below alone', () => {
    expect(visible(midiOf('B', 0, 3), 'G2', belowOnly)).toBe(true)
    expect(visible(midiOf('C', 0, 4), 'G2', belowOnly)).toBe(false)
    expect(visible(midiOf('C', 1, 5), 'G2', belowOnly)).toBe(false)
    expect(visible(midiOf('C', 0, 7), 'G2', belowOnly)).toBe(false)
  })

  it('show-above alone', () => {
    expect(visible(midiOf('C', 1, 5), 'G2', aboveOnly)).toBe(true)
    expect(visible(midiOf('C', 0, 5), 'G2', aboveOnly)).toBe(false)
    expect(visible(midiOf('B', 0, 3), 'G2', aboveOnly)).toBe(false)
  })

  it('both disabled labels nothing, even with thresholds stored', () => {
    const none = only({
      below: { enabled: false, threshold: sp('C', 0, 4) },
      above: { enabled: false, threshold: sp('C', 0, 5) },
    })
    for (const midi of [0, 40, 59, 73, 127]) expect(visible(midi, 'G2', none)).toBe(false)
  })

  it('an enabled condition without a threshold labels nothing', () => {
    const unset = only({ below: { enabled: true, threshold: null }, above: { enabled: true, threshold: null } })
    for (const midi of [0, 40, 73, 127]) expect(visible(midi, 'G2', unset)).toBe(false)
  })
})

describe('sounding pitch comparison, not spelling', () => {
  it('treats enharmonic equivalents identically', () => {
    // B♯3 sounds C4 and C♭5 sounds B4: both inside the unlabeled band.
    expect(visible(midiOf('B', 1, 3), 'G2', treble)).toBe(false)
    expect(visible(midiOf('C', -1, 5), 'G2', treble)).toBe(false)
    // B♯4 sounds C5 (boundary, unlabeled); A𝄪4 sounds B4; C♭4 sounds B3 (labeled).
    expect(visible(midiOf('B', 1, 4), 'G2', treble)).toBe(false)
    expect(visible(midiOf('C', -1, 4), 'G2', treble)).toBe(true)
    expect(visible(midiOf('D', -1, 4), 'G2', treble)).toBe(visible(midiOf('C', 1, 4), 'G2', treble))
  })

  it('applies strictness to thresholds with accidentals', () => {
    const rules = conditional({
      G2: { below: { enabled: true, threshold: sp('C', 1, 4) }, above: { enabled: true, threshold: sp('B', -1, 4) } },
    })
    expect(visible(midiOf('C', 0, 4), 'G2', rules)).toBe(true)
    expect(visible(midiOf('C', 1, 4), 'G2', rules)).toBe(false)
    expect(visible(midiOf('D', -1, 4), 'G2', rules)).toBe(false)
    expect(visible(midiOf('B', -1, 4), 'G2', rules)).toBe(false)
    expect(visible(midiOf('B', 0, 4), 'G2', rules)).toBe(true)
    // The threshold's spelling does not matter: A♯4 is the same key as B♭4.
    const sharpSpelled = conditional({
      G2: { below: { enabled: false, threshold: null }, above: { enabled: true, threshold: sp('A', 1, 4) } },
    })
    expect(visible(midiOf('A', 1, 4), 'G2', sharpSpelled)).toBe(false)
    expect(visible(midiOf('B', 0, 4), 'G2', sharpSpelled)).toBe(true)
  })
})

describe('clef independence', () => {
  const rules = conditional({
    G2: TREBLE_PRESET,
    F4: { below: { enabled: true, threshold: sp('E', 0, 2) }, above: { enabled: false, threshold: null } },
  })

  it('applies each clef its own rule', () => {
    // The same pitch is judged by the rule of the clef governing the note, not by its height.
    expect(visible(midiOf('C', 0, 3), 'G2', rules)).toBe(true)
    expect(visible(midiOf('C', 0, 3), 'F4', rules)).toBe(false)
    expect(visible(midiOf('D', 0, 2), 'F4', rules)).toBe(true)
    expect(visible(midiOf('C', 0, 6), 'F4', rules)).toBe(false)
    expect(visible(midiOf('C', 0, 6), 'G2', rules)).toBe(true)
  })

  it('gives a clef with no entry no labels and never copies another clef', () => {
    expect(visible(midiOf('B', 0, 2), 'C3', rules)).toBe(false)
    expect(visible(midiOf('C', 0, 7), 'C3', rules)).toBe(false)
  })

  it('disabling the bass rule does not affect the treble rule', () => {
    const bassOff = conditional({ G2: TREBLE_PRESET, F4: DISABLED_RULE })
    expect(visible(midiOf('B', 0, 3), 'G2', bassOff)).toBe(true)
    expect(visible(midiOf('B', 0, 1), 'F4', bassOff)).toBe(false)
  })

  it('evaluates chord members separately', () => {
    const chord = [midiOf('G', 0, 3), midiOf('C', 0, 4), midiOf('E', 0, 4), midiOf('C', 1, 5)]
    expect(chord.map((m) => visible(m, 'G2', treble))).toEqual([true, false, false, true])
  })
})

describe('ruleForClef and ruleLabelsMidi', () => {
  it('returns the stored rule, or a both-disabled rule that is not copied from treble', () => {
    expect(ruleForClef(treble, 'G2')).toBe(TREBLE_PRESET)
    const fresh = ruleForClef(treble, 'C3')
    expect(fresh).toEqual(DISABLED_RULE)
    expect(fresh).not.toEqual(TREBLE_PRESET)
  })

  it('ruleLabelsMidi is the strict OR of enabled conditions', () => {
    expect(ruleLabelsMidi(TREBLE_PRESET, 59)).toBe(true)
    expect(ruleLabelsMidi(TREBLE_PRESET, 60)).toBe(false)
    expect(ruleLabelsMidi(TREBLE_PRESET, 72)).toBe(false)
    expect(ruleLabelsMidi(TREBLE_PRESET, 73)).toBe(true)
    expect(ruleLabelsMidi(DISABLED_RULE, 10)).toBe(false)
  })
})
