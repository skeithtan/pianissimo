import { describe, expect, it } from 'vitest'
import { makePackage, makePiece } from '../../core/storage/testkit'
import { rat } from '../../core/music/rational'
import { useCatalog } from '../shared/catalogTesting'
import { continuationContext, continuingPiece, hasPracticeContext, neverOpened, openedStatus } from './continuation'

describe('Library continuation', () => {
  it('does not promote an imported or merely opened piece without saved practice context', () => {
    const piece = makePiece(makePackage(), { lastOpenedAt: 5000, lastMultiplier: 0.75 })
    expect(hasPracticeContext(piece)).toBe(false)
    expect(continuingPiece([piece])).toBeUndefined()
  })

  it('chooses the first saved context in the last-opened order', () => {
    const pkg = makePackage()
    const unopened = makePiece(pkg)
    const loop = makePiece(pkg, { id: 'loop', repeatOpen: true, lastPassage: { fromOcc: 1, toOcc: 2 } })
    const resume = makePiece(pkg, {
      id: 'resume',
      resume: { occ: 2, position: rat(2), hands: 'both', multiplier: 1, savedAt: 10 },
    })
    expect(continuingPiece([unopened, loop, resume])).toBe(loop)
    expect(continuingPiece([unopened, resume, loop])).toBe(resume)
  })

  it('uses printed bar numbers and pass numbers for a repeated passage', () => {
    const pkg = makePackage()
    const score = {
      ...pkg.model,
      occurrences: pkg.model.occurrences.map((bar) => ({ ...bar, number: String(bar.index + 10), pass: 2 })),
    }
    const piece = makePiece(pkg, {
      repeatOpen: true,
      lastPassage: { fromOcc: 1, toOcc: 2 },
      lastHands: 'left',
      lastMultiplier: 0.7,
    })
    expect(continuationContext(piece, score)).toBe('Repeat bars 11 (pass 2)–12 (pass 2) · left hand · 70% speed')
    expect(continuationContext(piece, null)).toBe('Repeat saved passage · left hand · 70% speed')
  })

  it('says a resume at the very beginning is from the start, even before the score is loaded', () => {
    const pkg = makePackage()
    const piece = makePiece(pkg, {
      resume: { occ: 0, position: rat(0), hands: 'both', multiplier: 1, savedAt: 10 },
    })
    expect(continuationContext(piece, pkg.model)).toBe('From the start · both hands')
    expect(continuationContext(piece, null)).toBe('From the start · both hands')
  })

  it('names the bar alone on its first beat, and the beat otherwise', () => {
    const pkg = makePackage()
    const onBar = makePiece(pkg, {
      lastHands: 'right',
      lastMultiplier: 0.8,
      resume: { occ: 2, position: rat(2), hands: 'right', multiplier: 0.8, savedAt: 10 },
    })
    expect(continuationContext(onBar, pkg.model)).toBe('From bar 3 · right hand · 80% speed')
    const onBeat = makePiece(pkg, {
      resume: { occ: 2, position: rat(5, 2), hands: 'both', multiplier: 1, savedAt: 10 },
    })
    expect(continuationContext(onBeat, pkg.model)).toBe('From bar 3, beat 3 · both hands')
  })

  it('does not describe an inactive saved loop as the current passage', () => {
    const pkg = makePackage()
    const piece = makePiece(pkg, {
      repeatOpen: false,
      lastPassage: { fromOcc: 0, toOcc: 1 },
      resume: { occ: 2, position: rat(2), hands: 'both', multiplier: 1, savedAt: 10 },
    })
    expect(continuationContext(piece, pkg.model)).toBe('From bar 3 · both hands')
  })

  it('normalizes restored loops whose bars and note edges are outside the score', () => {
    const pkg = makePackage()
    const piece = makePiece(pkg, {
      repeatOpen: true,
      lastPassage: { fromOcc: 99, toOcc: 101, start: rat(100), end: rat(102) },
    })
    expect(continuationContext(piece, pkg.model)).toBe('Repeat bar 4 · both hands')
  })

  it('names Repeat over the whole piece, and Listen (no hands) as "listening"', () => {
    const piece = makePiece(makePackage(), { repeatOpen: true, lastHands: 'none', lastMultiplier: 1.25 })
    expect(continuationContext(piece, null)).toBe('Repeat whole piece · listening · 125% speed')
    const fromStart = makePiece(makePackage(), {
      lastHands: 'none',
      resume: { occ: 0, position: rat(0), hands: 'none', multiplier: 1, savedAt: 10 },
    })
    expect(continuationContext(fromStart, null)).toBe('From the start · listening')
  })

  it('omits the speed only when it reads 100%', () => {
    const at = (lastMultiplier: number) =>
      continuationContext(makePiece(makePackage(), { repeatOpen: true, lastMultiplier }), null)
    expect(at(1)).toBe('Repeat whole piece · both hands')
    expect(at(0.95)).toBe('Repeat whole piece · both hands · 95% speed')
    expect(at(1.05)).toBe('Repeat whole piece · both hands · 105% speed')
    expect(at(0.9996)).toBe('Repeat whole piece · both hands')
    expect(at(1.0004)).toBe('Repeat whole piece · both hands')
    expect(at(0.999)).toBe('Repeat whole piece · both hands · 99.9% speed')
    const restore = useCatalog('fr-FR')
    try {
      expect(at(0.9996)).toBe('Répéter le morceau entier · deux mains')
    } finally {
      restore()
    }
  })

  it.each([-1, 4, 100])('does not label a restored position outside the score (%s)', (position) => {
    const pkg = makePackage()
    const piece = makePiece(pkg, {
      resume: { occ: 0, position: rat(position), hands: 'both', multiplier: 1, savedAt: 10 },
    })
    expect(continuationContext(piece, pkg.model)).toBe('Saved position · both hands')
  })
})

describe('Library status line', () => {
  const now = new Date(2026, 9, 29, 15, 0).getTime()
  const day = 86_400_000

  it('treats a piece as never opened while its last-opened time is not after its creation', () => {
    // An import stores both times equal; the initial pieces store last-opened a little earlier.
    expect(neverOpened({ createdAt: now, lastOpenedAt: now })).toBe(true)
    expect(neverOpened({ createdAt: now, lastOpenedAt: now - 2 })).toBe(true)
    expect(neverOpened({ createdAt: now, lastOpenedAt: now + 1 })).toBe(false)
    expect(openedStatus({ createdAt: now, lastOpenedAt: now }, now + 3 * day)).toBe('Not opened yet')
    expect(openedStatus({ createdAt: now, lastOpenedAt: now - 1 }, now)).toBe('Not opened yet')
  })

  it('says when an opened piece was last opened, never "practiced"', () => {
    const createdAt = now - 30 * day
    expect(openedStatus({ createdAt, lastOpenedAt: now - 10_000 }, now)).toBe('Opened just now')
    expect(openedStatus({ createdAt, lastOpenedAt: new Date(2026, 9, 28, 20).getTime() }, now)).toBe('Opened yesterday')
    expect(openedStatus({ createdAt, lastOpenedAt: new Date(2026, 9, 26, 9).getTime() }, now)).toBe('Opened 3 days ago')
    const older = new Date(2026, 9, 12, 9)
    expect(openedStatus({ createdAt, lastOpenedAt: older.getTime() }, now)).toBe(
      `Opened ${older.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
    )
  })
})
