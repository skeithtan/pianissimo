import { describe, expect, it } from 'vitest'
import type { InterruptReason } from '../model/practice'
import { ingestAbandon, ingestAttempt } from './ingest'
import { selectSuggestions } from './selection'
import { MKEY, PIECE, abandon, attemptOf, comparisonContext, fresh, occurrences, play } from './testkit'
import { measureContextKey } from '../model/practice'
import { toMeasureContext } from './contextKey'
import { barKey } from './types'
import type { PieceHistory } from './types'

const BAR = 12
const SCORE = occurrences(40)
const restarts = (h: PieceHistory) => h.suggestions.filter((s) => s.kind === 'restart' && s.status === 'active')
const shown = (h: PieceHistory) => selectSuggestions(h, SCORE, { scoreVersionId: 'v1', enabled: true })

const NOT_ABANDONMENT: readonly InterruptReason[] = [
  'pause',
  'seek',
  'disconnect',
  'suspend',
  'setting-change',
  'layout-change',
  'tempo-change',
  'hand-change',
  'range-change',
  'mode-change',
]

describe('repeated-restart suggestions', () => {
  it('three user-initiated restarts after wrong notes in one bar create a restart suggestion', () => {
    let h = abandon(fresh(), BAR, 'user-restart', 100)
    h = abandon(h, BAR, 'user-restart', 200)
    expect(restarts(h)).toHaveLength(0)
    h = abandon(h, BAR, 'user-restart', 300)
    expect(restarts(h)).toHaveLength(1)
    expect(restarts(h)[0]).toMatchObject({ kind: 'restart', coreFrom: BAR, coreTo: BAR })

    const [only] = shown(h).active
    expect(only).toMatchObject({ kind: 'restart', passage: { fromOcc: BAR - 1, toOcc: BAR + 1 } })
    expect(only?.evidence).toBe('You restarted at bar 13 after mistakes three times.')
    expect(only?.prompt).toBe('Practice bars 12–14?')
  })

  it('user stops count too, and mixed reasons are worded neutrally', () => {
    let h = abandon(fresh(), BAR, 'user-stop', 100)
    h = abandon(h, BAR, 'user-stop', 200)
    h = abandon(h, BAR, 'user-stop', 300)
    expect(shown(h).active[0]?.evidence).toBe('You stopped at bar 13 after mistakes three times.')

    let mixed = abandon(fresh(), BAR, 'user-stop', 100)
    mixed = abandon(mixed, BAR, 'user-restart', 200)
    mixed = abandon(mixed, BAR, 'user-restart', 300)
    expect(shown(mixed).active[0]?.evidence).toBe('You restarted or stopped at bar 13 after mistakes three times.')
  })

  it.each(NOT_ABANDONMENT)('%s never counts toward the trigger', (reason) => {
    let h = fresh()
    for (let i = 0; i < 6; i += 1) h = abandon(h, BAR, reason, 100 + i)
    expect(restarts(h)).toHaveLength(0)
    expect(h.abandons).toEqual({})
  })

  it('excluded reasons do not combine with real restarts to reach the trigger', () => {
    let h = abandon(fresh(), BAR, 'user-restart', 100)
    h = abandon(h, BAR, 'disconnect', 150)
    h = abandon(h, BAR, 'suspend', 160)
    h = abandon(h, BAR, 'seek', 170)
    h = abandon(h, BAR, 'user-restart', 200)
    expect(restarts(h)).toHaveLength(0)
    h = abandon(h, BAR, 'user-restart', 300)
    expect(restarts(h)).toHaveLength(1)
  })

  it('reports a change only for the bar whose events changed', () => {
    const event = { pieceId: PIECE, measureContextKey: MKEY, occ: BAR, at: 1, reason: 'seek' } as const
    const ignored = ingestAbandon(fresh(), event, 1)
    expect(ignored.changes).toEqual({ bars: [], suggestionsChanged: false, abandonKeys: [] })
    const kept = ingestAbandon(fresh(), { ...event, reason: 'user-restart' }, 1)
    expect(kept.changes.abandonKeys).toEqual([barKey(MKEY, BAR)])
    expect(kept.changes.suggestionsChanged).toBe(false)
  })

  it('is idempotent for the same event', () => {
    const event = { pieceId: PIECE, measureContextKey: MKEY, occ: BAR, at: 5, reason: 'user-restart' } as const
    const once = ingestAbandon(fresh(), event, 5)
    const twice = ingestAbandon(once.history, event, 6)
    expect(twice.history).toBe(once.history)
    expect(twice.changes.abandonKeys).toHaveLength(0)
  })

  it('never feeds the complete-pass percentages or the flag rule', () => {
    let h = fresh()
    for (let i = 0; i < 5; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i)
    expect(h.bars).toEqual({})
    expect(h.suggestions.every((s) => s.kind === 'restart')).toBe(true)
  })

  it('keeps only the five most recent events per bar', () => {
    let h = fresh()
    for (let i = 0; i < 8; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i)
    const events = h.abandons[barKey(MKEY, BAR)] ?? []
    expect(events.map((e) => e.at)).toEqual([103, 104, 105, 106, 107])
    expect(restarts(h)).toHaveLength(1)
  })

  it('adjacent restart bars merge into one suggestion with per-bar wording', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) {
      h = abandon(h, BAR, 'user-restart', 100 + i)
      h = abandon(h, BAR + 1, 'user-restart', 200 + i)
    }
    expect(restarts(h)).toHaveLength(1)
    expect(restarts(h)[0]).toMatchObject({ coreFrom: BAR, coreTo: BAR + 1 })
    expect(shown(h).active[0]?.evidence).toBe('You restarted after mistakes at bar 13 three times, bar 14 three times.')
  })

  it('is shown after suggestions backed by complete traversals', () => {
    let h = fresh()
    for (let i = 0; i < 4; i += 1) h = abandon(h, 30, 'user-restart', 100 + i)
    h = play(h, BAR, ['error', 'error', 'error'])
    const view = shown(h)
    expect(view.active.map((s) => s.kind)).toEqual(['traversal', 'restart'])
  })

  it('does not duplicate a bar already covered by a traversal suggestion', () => {
    let h = play(fresh(), BAR, ['error', 'error', 'error'])
    for (let i = 0; i < 3; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i)
    expect(restarts(h)).toHaveLength(0)
    expect(shown(h).active).toHaveLength(1)
  })

  it('hides a restart suggestion once a traversal suggestion covers its bars', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i)
    expect(shown(h).active.map((s) => s.kind)).toEqual(['restart'])
    h = play(h, BAR, ['error', 'error', 'error'])
    expect(shown(h).active.map((s) => s.kind)).toEqual(['traversal'])
  })

  it('is resolved by three clean unassisted complete traversals and its events are cleared', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i)
    h = play(h, BAR, ['clean', 'clean'])
    expect(restarts(h)).toHaveLength(1)
    expect(shown(h).active[0]?.progress.text).toBe('2 of 3 clean passes')
    h = play(h, BAR, ['clean'])
    expect(restarts(h)).toHaveLength(0)
    expect(shown(h).improved).toHaveLength(1)
    expect(h.abandons[barKey(MKEY, BAR)]).toEqual([])
  })

  it('keeps contexts apart: restarts at another tempo are a separate suggestion', () => {
    const slow = measureContextKey(toMeasureContext(comparisonContext({ multiplier: 0.5 })))
    let h = fresh()
    for (let i = 0; i < 3; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i)
    for (let i = 0; i < 2; i += 1) h = abandon(h, BAR, 'user-restart', 200 + i, slow)
    expect(restarts(h)).toHaveLength(1)
    h = abandon(h, BAR, 'user-restart', 300, slow)
    expect(restarts(h)).toHaveLength(2)
    expect(shown(h).active.map((s) => s.hands + s.multiplier)).toEqual(expect.arrayContaining(['both1', 'both0.5']))
  })

  it('records the event but builds no suggestion for an unreadable context key', () => {
    let h = fresh()
    for (let i = 0; i < 4; i += 1) h = abandon(h, BAR, 'user-restart', 100 + i, 'legacy-key')
    expect(restarts(h)).toHaveLength(0)
    expect(h.abandons[barKey('legacy-key', BAR)]).toHaveLength(4)
  })

  it('rejects an event for another piece', () => {
    expect(() =>
      ingestAbandon(
        fresh(),
        { pieceId: 'someone-else', measureContextKey: MKEY, occ: 1, at: 1, reason: 'user-stop' },
        1,
      ),
    ).toThrow(RangeError)
  })

  it('attempts with only incomplete visits leave the restart evidence alone', () => {
    let h = abandon(fresh(), BAR, 'user-restart', 100)
    h = ingestAttempt(
      h,
      attemptOf([[BAR, 'partial-error']], { completion: 'abandoned', interruptReason: 'user-restart' }),
      110,
    ).history
    expect(h.abandons[barKey(MKEY, BAR)]).toHaveLength(1)
    expect(h.bars).toEqual({})
  })
})
