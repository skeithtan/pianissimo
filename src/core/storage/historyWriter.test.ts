import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectSuggestions } from '../history/selection'
import { occurrences, traversal } from '../history/testkit'
import type { PieceHistory } from '../history/types'
import type { AbandonEvent } from '../model/practice'
import { comparisonContext } from '../history/testkit'
import { contextKey, measureContextKey } from '../model/practice'
import { toMeasureContext } from '../history/contextKey'
import { HistoryWriter, MAX_FLUSH_FAILURES, defaultSchedule } from './historyWriter'
import type { FlushReport, HistoryWriterOptions, LifecycleTargets } from './historyWriter'
import { openPianissimoDb as openPianissimo } from './schema'
import { attemptFor, freshName, importPiece, openFresh } from './testkit'
import { openStorage } from './storage'
import type { PianissimoStorage } from './storage'

const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

/** A scheduler the test fires by hand. */
function manualSchedule() {
  const pending: Array<() => void> = []
  return {
    schedule: (run: () => void) => {
      pending.push(run)
      return () => {
        const at = pending.indexOf(run)
        if (at >= 0) pending.splice(at, 1)
      }
    },
    pending,
    fire: () => pending.splice(0).forEach((run) => run()),
  }
}

async function setup(options: HistoryWriterOptions = {}) {
  const db = await openPianissimo(freshName())
  closers.push(() => db.close())
  const manual = manualSchedule()
  const writer = new HistoryWriter(db, { schedule: manual.schedule, ...options })
  return { db, writer, manual }
}

const PIECE = 'p1'
const errorBar = (occ: number) => [[occ, 'error']] as const

describe('queueing', () => {
  it('only queues on the calling path and writes later, from the scheduler', async () => {
    const { db, writer, manual } = await setup()
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    expect(writer.pending).toBe(1)
    expect(manual.pending).toHaveLength(1)
    expect(await db.count('attempts')).toBe(0)
    expect(await db.count('measureHistory')).toBe(0)

    manual.fire()
    await writer.flush()
    expect(writer.pending).toBe(0)
    expect(await db.count('attempts')).toBe(1)
    expect(await db.count('measureHistory')).toBe(1)
    expect(await db.count('suggestionState')).toBe(0) // one bad pass flags nothing
  })

  it('arms a single timer for any number of queued items', async () => {
    const { writer, manual } = await setup()
    for (let i = 0; i < 20; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    writer.queueAbandon(abandon(3, 1))
    expect(manual.pending).toHaveLength(1)
    await writer.flush()
    expect(manual.pending).toHaveLength(0)
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    expect(manual.pending).toHaveLength(1)
  })

  it('flush returns a report and an empty flush is a no-op', async () => {
    const { writer } = await setup()
    expect(await writer.flush()).toEqual({ attempts: 0, abandons: 0, suggestionsChanged: [], pieces: [] })
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    writer.queueAbandon(abandon(3, 1))
    const report = await writer.flush()
    expect(report).toMatchObject({ attempts: 1, abandons: 1, pieces: [PIECE] })
  })

  it('notifies subscribers after a flush that wrote something', async () => {
    const reports: FlushReport[] = []
    const { writer } = await setup({ onFlush: (r) => reports.push(r) })
    const later = vi.fn()
    const off = writer.subscribe(later)
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    await writer.flush()
    await writer.flush()
    expect(reports).toHaveLength(1)
    expect(later).toHaveBeenCalledTimes(1)
    off()
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    await writer.flush()
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('uses an idle callback when there is one and a timer when there is not', async () => {
    const calls: string[] = []
    const host = globalThis as unknown as Record<string, unknown>
    host['requestIdleCallback'] = (run: () => void, options: { timeout: number }) => {
      calls.push(`idle:${options.timeout}`)
      run()
      return 7
    }
    host['cancelIdleCallback'] = (handle: number) => calls.push(`cancel:${handle}`)
    try {
      const cancel = defaultSchedule(() => calls.push('ran'))
      cancel()
    } finally {
      delete host['requestIdleCallback']
      delete host['cancelIdleCallback']
    }
    expect(calls).toEqual(['idle:2000', 'ran', 'cancel:7'])

    vi.useFakeTimers()
    try {
      const ran = vi.fn()
      defaultSchedule(ran)
      expect(ran).not.toHaveBeenCalled()
      vi.advanceTimersByTime(500)
      expect(ran).toHaveBeenCalledTimes(1)
      const canceled = vi.fn()
      defaultSchedule(canceled)()
      vi.advanceTimersByTime(5_000)
      expect(canceled).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

function abandon(occ: number, n: number): AbandonEvent {
  return {
    pieceId: PIECE,
    measureContextKey: measureContextKey(toMeasureContext(comparisonContext())),
    occ,
    at: 90_000 + n,
    reason: 'user-restart',
  }
}

describe('lifecycle flushing', () => {
  function fakeTargets() {
    const listeners = new Map<string, Set<() => void>>()
    const target = <T extends object>(extra: T) => ({
      ...extra,
      addEventListener: (type: string, fn: () => void) => {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    })
    const document = target({ visibilityState: 'visible' as string })
    const targets: LifecycleTargets = { window: target({}), document }
    const emit = (type: string) => listeners.get(type)?.forEach((fn) => fn())
    return { targets, document, emit, count: (type: string) => listeners.get(type)?.size ?? 0 }
  }

  it('flushes on pagehide', async () => {
    const { db, writer } = await setup()
    const env = fakeTargets()
    writer.attachLifecycle(env.targets)
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    env.emit('pagehide')
    await vi.waitFor(async () => expect(await db.count('attempts')).toBe(1))
  })

  it('flushes when the page becomes hidden, not when it becomes visible', async () => {
    const { db, writer } = await setup()
    const env = fakeTargets()
    writer.attachLifecycle(env.targets)
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    env.emit('visibilitychange')
    expect(writer.pending).toBe(1)
    env.document.visibilityState = 'hidden'
    env.emit('visibilitychange')
    await vi.waitFor(async () => expect(await db.count('attempts')).toBe(1))
    expect(writer.pending).toBe(0)
  })

  it('detaches its listeners', async () => {
    const { writer } = await setup()
    const env = fakeTargets()
    const detach = writer.attachLifecycle(env.targets)
    expect(env.count('pagehide')).toBe(1)
    expect(env.count('visibilitychange')).toBe(1)
    detach()
    expect(env.count('pagehide')).toBe(0)
    expect(env.count('visibilitychange')).toBe(0)
  })

  it('does nothing outside a browser', async () => {
    const { writer } = await setup()
    expect(() => writer.attachLifecycle()()).not.toThrow()
  })

  it('dispose detaches and flushes what is left', async () => {
    const { db, writer } = await setup()
    const env = fakeTargets()
    writer.attachLifecycle(env.targets)
    writer.queueAttempt(attemptFor(PIECE, errorBar(3)))
    await writer.dispose()
    expect(env.count('pagehide')).toBe(0)
    expect(await db.count('attempts')).toBe(1)
  })
})

describe('suggested practice through the writer', () => {
  it('flags a bar after three error-bearing passes and persists the suggestion', async () => {
    const { db, writer } = await setup()
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    const report = await writer.flush()
    expect(report.suggestionsChanged).toEqual([PIECE])

    const stored = await db.get('suggestionState', PIECE)
    expect(stored?.suggestions).toHaveLength(1)
    expect(stored?.suggestions[0]).toMatchObject({ kind: 'traversal', status: 'active', coreFrom: 12, coreTo: 12 })
    expect(await db.count('measureHistory')).toBe(1)
    expect(await db.count('attempts')).toBe(3)
  })

  it('a new session reloads the persisted history and continues towards recovery', async () => {
    const name = freshName()
    const first = await openStorage(name)
    for (let i = 0; i < 3; i += 1) first.history.queueAttempt(attemptFor(PIECE, errorBar(12)))
    await first.history.flush()
    first.close()

    const second = await openStorage(name)
    closers.push(() => second.close())
    const history = await second.loadPieceHistory(PIECE)
    const before = selectSuggestions(history, occurrences(40), { scoreVersionId: 'v1', enabled: true })
    expect(before.active).toHaveLength(1)
    expect(before.active[0]?.evidence).toBe('Mistakes in bar 13 on 3 of your last 3 comparable passes.')

    for (let i = 0; i < 2; i += 1) second.history.queueAttempt(attemptFor(PIECE, [[12, 'clean']]))
    const midway = selectSuggestions(await second.loadPieceHistory(PIECE), occurrences(40), {
      scoreVersionId: 'v1',
      enabled: true,
    })
    expect(midway.active[0]?.progress.text).toBe('2 of 3 clean passes')

    second.history.queueAttempt(attemptFor(PIECE, [[12, 'clean']]))
    const done = selectSuggestions(await second.loadPieceHistory(PIECE), occurrences(40), {
      scoreVersionId: 'v1',
      enabled: true,
    })
    expect(done.active).toHaveLength(0)
    expect(done.improved).toHaveLength(1)

    // And the improvement is persisted for the next reload.
    second.close()
    const third = await openStorage(name)
    closers.push(() => third.close())
    const reloaded = selectSuggestions(await third.loadPieceHistory(PIECE), occurrences(40), {
      scoreVersionId: 'v1',
      enabled: true,
    })
    expect(reloaded.improved).toHaveLength(1)
  })

  it('applies queued items in order within one flush', async () => {
    const { writer } = await setup()
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, [[12, 'clean']]))
    const history = await writer.getHistory(PIECE)
    expect(history.suggestions).toHaveLength(1)
    expect(history.suggestions[0]?.status).toBe('improved')
  })

  it('getHistory includes records that are still queued', async () => {
    const { writer } = await setup()
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    expect(writer.pending).toBe(3)
    const history = await writer.getHistory(PIECE)
    expect(history.suggestions).toHaveLength(1)
    expect(writer.pending).toBe(0)
  })

  it('keeps pieces apart', async () => {
    const { writer } = await setup()
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor('A', errorBar(12)))
    for (let i = 0; i < 2; i += 1) writer.queueAttempt(attemptFor('B', errorBar(12)))
    expect((await writer.getHistory('A')).suggestions).toHaveLength(1)
    expect((await writer.getHistory('B')).suggestions).toHaveLength(0)
  })

  it('three user restarts persist as a separate restart suggestion; device interruptions do not', async () => {
    const { writer } = await setup()
    for (let i = 0; i < 5; i += 1) writer.queueAbandon({ ...abandon(12, i), reason: 'disconnect' })
    expect((await writer.getHistory(PIECE)).suggestions).toHaveLength(0)
    for (let i = 0; i < 3; i += 1) writer.queueAbandon(abandon(12, 10 + i))
    const history = await writer.getHistory(PIECE)
    expect(history.suggestions.map((s) => s.kind)).toEqual(['restart'])
    expect(Object.values(history.abandons).flat()).toHaveLength(3)
  })

  it('loop-boundary reattacks never inflate the history', async () => {
    const { writer, db } = await setup()
    const boundary = { ...traversal(12, 'clean'), wrongAttacks: 4, wrongAttacksExcludingBoundary: 0 }
    for (let i = 0; i < 5; i += 1) writer.queueAttempt(attemptFor(PIECE, [], { measures: [boundary] }))
    const history = await writer.getHistory(PIECE)
    expect(history.suggestions).toEqual([])
    expect((await db.getAll('measureHistory'))[0]?.recent.every((s) => !s.errorBearing)).toBe(true)
  })

  it('removes abandon records when a recovery clears them', async () => {
    const { writer, db } = await setup()
    for (let i = 0; i < 3; i += 1) writer.queueAbandon(abandon(12, i))
    await writer.flush()
    expect(await db.count('abandonEvents')).toBe(1)
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, [[12, 'clean']]))
    await writer.flush()
    expect(await db.count('abandonEvents')).toBe(0)
    expect((await writer.getHistory(PIECE)).suggestions[0]?.status).toBe('improved')
  })
})

describe('which attempt records are kept', () => {
  it('stores scored attempts but only feeds ordinary reading into the histories', async () => {
    const { writer, db } = await setup()
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(12), { kind: 'reading' }))
    const history = await writer.getHistory(PIECE)
    expect(history.suggestions).toHaveLength(1)
    expect(await db.count('attempts')).toBe(0)
  })

  it('can keep reading attempts on request', async () => {
    const { writer, db } = await setup({ keepReadingAttempts: true })
    writer.queueAttempt(attemptFor(PIECE, errorBar(12), { kind: 'reading' }))
    await writer.flush()
    expect(await db.count('attempts')).toBe(1)
  })

  it('records nothing for Preview', async () => {
    const { writer, db } = await setup()
    const preview = comparisonContext({ hands: 'none' })
    for (let i = 0; i < 4; i += 1) {
      writer.queueAttempt(attemptFor(PIECE, errorBar(12), { context: preview, contextKey: contextKey(preview) }))
    }
    await writer.flush()
    expect(await db.count('attempts')).toBe(0)
    expect(await db.count('measureHistory')).toBe(0)
  })

  it('keeps interrupted attempts with their reason but never lets them count as completions', async () => {
    const { writer, db } = await setup()
    writer.queueAttempt(
      attemptFor(PIECE, [], { completion: 'interrupted', interruptReason: 'disconnect', passed: false }),
    )
    await writer.flush()
    const [stored] = await db.getAll('attempts')
    expect(stored).toMatchObject({ completion: 'interrupted', interruptReason: 'disconnect' })
  })
})

describe('failure handling', () => {
  /** A database whose read-write transactions fail the first `failures` times. */
  async function flaky(failures: number, options: HistoryWriterOptions = {}) {
    const real = await openPianissimo(freshName())
    closers.push(() => real.close())
    let left = failures
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (stores: never, mode?: IDBTransactionMode) => {
            if (mode === 'readwrite' && left > 0) {
              left -= 1
              throw new Error('QuotaExceededError')
            }
            return (target.transaction as (...a: unknown[]) => unknown)(stores, mode)
          }
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
    const manual = manualSchedule()
    const writer = new HistoryWriter(db, { schedule: manual.schedule, ...options })
    return { real, writer, manual }
  }

  it('keeps the batch and writes it on the next flush', async () => {
    const onError = vi.fn()
    const { real, writer, manual } = await flaky(1, { onError })
    for (let i = 0; i < 3; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    await expect(writer.flush()).rejects.toThrow(/Quota/)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(writer.pending).toBe(3)
    expect(manual.pending).toHaveLength(1) // a retry is scheduled
    expect(await real.count('attempts')).toBe(0)

    await writer.flush()
    expect(writer.pending).toBe(0)
    expect(await real.count('attempts')).toBe(3)
    expect((await real.get('suggestionState', PIECE))?.suggestions).toHaveLength(1)
  })

  it('does not double-count a retried batch', async () => {
    const { writer } = await flaky(1)
    for (let i = 0; i < 2; i += 1) writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    await writer.flush().catch(() => undefined)
    await writer.flush()
    const bar = Object.values((await writer.getHistory(PIECE)).bars)[0]
    expect(bar?.recent).toHaveLength(2)
  })

  it('drops a batch that keeps failing so the queue cannot wedge', async () => {
    const onError = vi.fn()
    const { writer, real } = await flaky(MAX_FLUSH_FAILURES, { onError })
    writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    for (let i = 0; i < MAX_FLUSH_FAILURES; i += 1) await writer.flush().catch(() => undefined)
    expect(writer.pending).toBe(0)
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), 1)
    writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    await writer.flush()
    expect(await real.count('attempts')).toBe(1)
  })

  it('drops one malformed record without losing the rest of the batch', async () => {
    const onError = vi.fn()
    const { writer, db } = await setup({ onError })
    const bad = { ...attemptFor(PIECE, errorBar(12)), measures: undefined } as never
    writer.queueAttempt(bad)
    writer.queueAttempt(attemptFor(PIECE, errorBar(12)))
    await writer.flush()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(await db.count('attempts')).toBe(1)
  })
})

describe('piece controls', () => {
  async function withPiece(): Promise<{ s: PianissimoStorage; pieceId: string }> {
    const s = await openFresh()
    closers.push(() => s.close())
    const { piece } = await importPiece(s, 'v1')
    return { s, pieceId: piece.id }
  }

  it('discards queued records of a piece', async () => {
    const { writer } = await setup()
    writer.queueAttempt(attemptFor('A', errorBar(1)))
    writer.queueAttempt(attemptFor('B', errorBar(1)))
    writer.queueAbandon({ ...abandon(1, 1), pieceId: 'A' })
    writer.discard('A')
    expect(writer.pending).toBe(1)
  })

  it('disabling suggestions persists and evidence keeps accumulating', async () => {
    const { s, pieceId } = await withPiece()
    await s.setSuggestionsDisabled(pieceId, true)
    for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(pieceId, errorBar(12)))
    const history: PieceHistory = await s.loadPieceHistory(pieceId)
    expect(history.disabled).toBe(true)
    expect(history.suggestions).toHaveLength(1)
    expect(selectSuggestions(history, occurrences(40), { scoreVersionId: 'v1', enabled: true }).disabled).toBe(true)
    await s.setSuggestionsDisabled(pieceId, false)
    const again = await s.loadPieceHistory(pieceId)
    expect(selectSuggestions(again, occurrences(40), { scoreVersionId: 'v1', enabled: true }).active).toHaveLength(1)
  })

  it('clearing the practice history removes measure histories and suggestions but keeps results and the disable switch', async () => {
    const { s, pieceId } = await withPiece()
    await s.setSuggestionsDisabled(pieceId, true)
    for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(pieceId, errorBar(12)))
    for (let i = 0; i < 3; i += 1) s.history.queueAbandon({ ...abandon(20, i), pieceId })
    await s.history.flush()

    await s.clearPracticeHistory(pieceId)
    const history = await s.loadPieceHistory(pieceId)
    expect(history).toMatchObject({ bars: {}, suggestions: [], abandons: {}, disabled: true })
    expect(await s.listAttempts({ pieceId })).toHaveLength(3)

    // Evidence starts over: two passes are not enough.
    for (let i = 0; i < 2; i += 1) s.history.queueAttempt(attemptFor(pieceId, errorBar(12)))
    expect((await s.loadPieceHistory(pieceId)).suggestions).toHaveLength(0)
  })

  it('can also clear the attempt records', async () => {
    const { s, pieceId } = await withPiece()
    s.history.queueAttempt(attemptFor(pieceId, errorBar(12)))
    await s.history.flush()
    await s.clearPracticeHistory(pieceId, { attempts: true })
    expect(await s.listAttempts({ pieceId })).toEqual([])
  })

  it('writes queued records before clearing so nothing reappears afterwards', async () => {
    const { s, pieceId } = await withPiece()
    for (let i = 0; i < 3; i += 1) s.history.queueAttempt(attemptFor(pieceId, errorBar(12)))
    await s.clearPracticeHistory(pieceId)
    await s.history.flush()
    expect((await s.loadPieceHistory(pieceId)).suggestions).toEqual([])
  })
})
