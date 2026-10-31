import { describe, expect, it } from 'vitest'
import { contextKey, handAssignmentId } from './practice'
import type { ComparisonContext } from './practice'

describe('handAssignmentId', () => {
  it('depends only on the voice → hand pairs, not their order or confirmation', () => {
    const a = handAssignmentId({ byVoice: { 'P1:1': 'R', 'P1:2': 'L' }, ambiguousVoices: [], confirmed: false })
    const b = handAssignmentId({ byVoice: { 'P1:2': 'L', 'P1:1': 'R' }, ambiguousVoices: ['P1:2'], confirmed: true })
    expect(a).toBe(b)
    expect(a).toMatch(/^h[0-9a-f]{8}$/)
  })

  it('changes when a voice moves to the other hand', () => {
    const a = handAssignmentId({ byVoice: { 'P1:1': 'R', 'P1:2': 'L' }, ambiguousVoices: [], confirmed: true })
    const b = handAssignmentId({ byVoice: { 'P1:1': 'R', 'P1:2': 'R' }, ambiguousVoices: [], confirmed: true })
    expect(a).not.toBe(b)
  })

  it('is part of the comparison key', () => {
    const c: ComparisonContext = {
      scoreVersionId: 'v',
      passage: { fromOcc: 0, toOcc: 1 },
      hands: 'both',
      handsId: 'h1',
      tempoMapId: 't',
      multiplier: 1,
      rollPolicy: 'r',
      transport: 'free',
      matchingRules: 'm',
    }
    expect(contextKey(c)).not.toBe(contextKey({ ...c, handsId: 'h2' }))
  })
})
