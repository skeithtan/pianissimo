import { describe, expect, it } from 'vitest'
import {
  MAX_STEP_MULTIPLIER,
  MIN_MULTIPLIER,
  canStepMultiplier,
  formatBpm,
  formatSpeedPercent,
  offsetOnGrid,
  parseSpeedInput,
  stepMultiplier,
} from './speed'

describe('stepMultiplier', () => {
  it('steps by five percentage points', () => {
    expect(stepMultiplier(1, 1)).toBe(1.05)
    expect(stepMultiplier(1, -1)).toBe(0.95)
    expect(stepMultiplier(0.5, 1)).toBe(0.55)
    expect(stepMultiplier(0.75, -1)).toBe(0.7)
  })

  it('moves a value off the grid to the next grid value', () => {
    expect(stepMultiplier(0.62, 1)).toBe(0.65)
    expect(stepMultiplier(0.62, -1)).toBe(0.6)
    expect(stepMultiplier(1.01, 1)).toBe(1.05)
    expect(stepMultiplier(1.01, -1)).toBe(1)
    expect(stepMultiplier(0.6, 1)).toBe(0.65) // 0.6 is on the grid despite float noise
    expect(stepMultiplier(0.1 + 0.2 + 0.3, -1)).toBe(0.55)
  })

  it('clamps at 5% and 400%', () => {
    expect(stepMultiplier(MIN_MULTIPLIER, -1)).toBe(MIN_MULTIPLIER)
    expect(stepMultiplier(0.07, -1)).toBe(MIN_MULTIPLIER)
    expect(stepMultiplier(MAX_STEP_MULTIPLIER, 1)).toBe(MAX_STEP_MULTIPLIER)
    expect(stepMultiplier(3.98, 1)).toBe(MAX_STEP_MULTIPLIER)
  })

  it('never lowers a custom speed above the cap when "+" is pressed', () => {
    expect(stepMultiplier(6, 1)).toBe(6)
  })

  it('reports whether a press changes anything', () => {
    expect(canStepMultiplier(MIN_MULTIPLIER, -1)).toBe(false)
    expect(canStepMultiplier(MIN_MULTIPLIER, 1)).toBe(true)
    expect(canStepMultiplier(MAX_STEP_MULTIPLIER, 1)).toBe(false)
    expect(canStepMultiplier(1, -1)).toBe(true)
  })

  it('repeated presses walk the whole grid without drifting', () => {
    let m = 1
    for (let i = 0; i < 19; i++) m = stepMultiplier(m, -1)
    expect(m).toBe(MIN_MULTIPLIER)
    for (let i = 0; i < 79; i++) m = stepMultiplier(m, 1)
    expect(m).toBe(MAX_STEP_MULTIPLIER)
  })
})

describe('offsetOnGrid', () => {
  it('adds or takes away a step and lands on the 5% grid', () => {
    expect(offsetOnGrid(0.6, 0.05)).toBe(0.65)
    expect(offsetOnGrid(0.65, -0.05)).toBe(0.6)
    expect(offsetOnGrid(0.7, 0.1)).toBe(0.8)
    // Off-grid speeds and steps land on the nearest grid value.
    expect(offsetOnGrid(0.62, 0.05)).toBe(0.65)
    expect(offsetOnGrid(0.6, 0.07)).toBe(0.65)
  })

  it('stays within 5%..1000%', () => {
    expect(offsetOnGrid(0.05, -0.05)).toBe(MIN_MULTIPLIER)
    expect(offsetOnGrid(10, 0.5)).toBe(10)
  })
})

describe('parseSpeedInput', () => {
  const ok = (text: string, bpm = 72, bare: 'multiplier' | 'bpm' = 'multiplier') => {
    const r = parseSpeedInput(text, bpm, bare)
    if (!r.ok) throw new Error(`expected ok for "${text}": ${r.error}`)
    return r
  }
  const bad = (text: string, bpm = 72, bare: 'multiplier' | 'bpm' = 'multiplier') => {
    const r = parseSpeedInput(text, bpm, bare)
    if (r.ok) throw new Error(`expected an error for "${text}", got ${r.multiplier}`)
    return r.error
  }

  it('reads multipliers, including the spec examples 0.6x and 1.8x', () => {
    expect(ok('0.6')).toEqual({ ok: true, multiplier: 0.6, kind: 'multiplier' })
    expect(ok('1.8x').multiplier).toBe(1.8)
    expect(ok('1.8×').multiplier).toBe(1.8)
    expect(ok('x0.6').multiplier).toBe(0.6)
    expect(ok('0,6').multiplier).toBe(0.6)
    expect(ok(' .75 ').multiplier).toBe(0.75)
    expect(ok('2').multiplier).toBe(2)
  })

  it('reads percentages', () => {
    expect(ok('60%')).toEqual({ ok: true, multiplier: 0.6, kind: 'percent' })
    expect(ok('150 %').multiplier).toBe(1.5)
    expect(ok('62.5%').multiplier).toBe(0.625)
  })

  it('reads BPM against the source tempo of the shown beat unit', () => {
    expect(ok('36 bpm', 72)).toEqual({ ok: true, multiplier: 0.5, kind: 'bpm' })
    expect(ok('BPM 144', 72).multiplier).toBe(2)
    expect(ok('♩ = 54 bpm', 72).multiplier).toBe(0.75)
    expect(ok('♩. = 30', 60, 'bpm').multiplier).toBe(0.5)
    expect(ok('90', 60, 'bpm').multiplier).toBe(1.5)
  })

  it('rejects zero and negative values', () => {
    expect(bad('0')).toMatch(/greater than zero/u)
    expect(bad('0%')).toMatch(/greater than zero/u)
    expect(bad('0 bpm')).toMatch(/greater than zero/u)
    expect(bad('-1')).toMatch(/greater than zero/u)
    expect(bad('-50%')).toMatch(/greater than zero/u)
  })

  it('rejects non-finite and unparseable text', () => {
    expect(bad('')).toMatch(/Enter a speed/u)
    expect(bad('   ')).toMatch(/Enter a speed/u)
    expect(bad('fast')).toMatch(/Could not read/u)
    expect(bad('NaN')).toMatch(/Could not read/u)
    expect(bad('Infinity')).toMatch(/Could not read/u)
    expect(bad('1e999')).toMatch(/Could not read/u)
    expect(bad('1.2.3')).toMatch(/Could not read/u)
    expect(bad('0.6 0.7')).toMatch(/Could not read/u)
    expect(bad('%')).toMatch(/Could not read/u)
  })

  it('rejects absurdly slow or fast values with a useful hint', () => {
    expect(bad('1%')).toMatch(/slower than 5%/u)
    expect(bad('0.01')).toMatch(/slower than 5%/u)
    expect(bad('60')).toMatch(/Write 60% for 60 percent/u)
    expect(bad('2000%')).toMatch(/faster than 10 times/u)
    expect(bad('9999')).toMatch(/faster than 10 times/u)
  })

  it('needs a source tempo for BPM entry', () => {
    expect(bad('60 bpm', 0)).toMatch(/original tempo first/u)
    expect(bad('60 bpm', Number.NaN)).toMatch(/original tempo first/u)
    expect(ok('0.6', 0).multiplier).toBe(0.6) // multipliers do not
  })
})

describe('formatting', () => {
  it('formats the speed as a percentage', () => {
    expect(formatSpeedPercent(1)).toBe('100%')
    expect(formatSpeedPercent(0.6)).toBe('60%')
    expect(formatSpeedPercent(0.625)).toBe('62.5%')
    expect(formatSpeedPercent(1.8)).toBe('180%')
    expect(formatSpeedPercent(0.1 + 0.2)).toBe('30%')
  })

  it('formats BPM as a whole number when close to one', () => {
    expect(formatBpm(72)).toBe('72')
    expect(formatBpm(71.98)).toBe('72')
    expect(formatBpm(43.2)).toBe('43.2')
  })
})
