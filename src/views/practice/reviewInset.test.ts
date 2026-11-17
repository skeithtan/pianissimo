import { describe, expect, it } from 'vitest'
import { REVIEW_CARD_GAP, reviewInsetFor, reviewTopFor } from './reviewInset'

describe('review insets (U97)', () => {
  it('keeps the dock and the top overlays clear, nothing without them', () => {
    // Stage 100–700, a 60 px card 12 px above its bottom edge.
    expect(reviewInsetFor(700, 628, 60)).toBe(72 + REVIEW_CARD_GAP)
    expect(reviewInsetFor(700, 700, 0)).toBe(0)
    // A 56 px Repeat panel 8 px below the stage's top edge.
    expect(reviewTopFor(100, 164, 56)).toBe(64 + REVIEW_CARD_GAP)
    expect(reviewTopFor(100, 108, 0)).toBe(0)
  })
})
