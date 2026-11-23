import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeSettings,
  connectionOpen,
  currentView,
  navigate,
  openConnection,
  openPractice,
  openSettings,
  practiceRequest,
  settingsOpen,
  settingsTab,
} from './navigation'
import { routeFromSignals, startRouter, type RouterWindow } from './router'

type Listener = () => void

interface Entry {
  hash: string
  state: unknown
}

/**
 * A minimal session history: entries, an index, `pushState` / `replaceState`, and an
 * asynchronous `back()` like a real browser (the traversal happens later, in `settle`).
 * `userBack` / `userForward` / `typeHash` act as the person using the browser chrome.
 */
class FakeBrowser implements RouterWindow {
  entries: Entry[]
  index: number
  writes = { push: 0, replace: 0, back: 0 }
  private readonly queue: Array<() => void> = []
  private readonly listeners: Record<string, Set<Listener>> = { popstate: new Set(), hashchange: new Set() }

  constructor(hash = '', state: unknown = null) {
    this.entries = [{ hash, state }]
    this.index = 0
    const self = this
    this.history = {
      get state(): unknown {
        return self.entries[self.index]!.state
      },
      pushState(next: unknown, _unused: string, url: string): void {
        self.writes.push++
        self.entries.splice(self.index + 1)
        self.entries.push({ hash: url, state: structuredClone(next) })
        self.index++
      },
      replaceState(next: unknown, _unused: string, url: string): void {
        self.writes.replace++
        self.entries[self.index] = { hash: url, state: structuredClone(next) }
      },
      back(): void {
        self.writes.back++
        self.queue.push(() => self.go(-1))
      },
    }
  }

  get location(): { readonly hash: string } {
    return { hash: this.entries[this.index]!.hash }
  }

  readonly history: RouterWindow['history']

  addEventListener(type: 'popstate' | 'hashchange', listener: Listener): void {
    this.listeners[type]!.add(listener)
  }
  removeEventListener(type: 'popstate' | 'hashchange', listener: Listener): void {
    this.listeners[type]!.delete(listener)
  }
  listenerCount(): number {
    return this.listeners['popstate']!.size + this.listeners['hashchange']!.size
  }

  private go(delta: number): void {
    const target = this.index + delta
    if (target < 0 || target >= this.entries.length) return
    const hashChanged = this.entries[target]!.hash !== this.entries[this.index]!.hash
    this.index = target
    this.listeners['popstate']!.forEach((l) => l())
    if (hashChanged) this.listeners['hashchange']!.forEach((l) => l())
  }
  userBack(): void {
    this.go(-1)
  }
  userForward(): void {
    this.go(1)
  }
  /** The person edits the address bar to another hash (a new entry, popstate and hashchange). */
  typeHash(hash: string): void {
    this.entries.splice(this.index + 1)
    this.entries.push({ hash, state: null })
    this.index++
    this.listeners['popstate']!.forEach((l) => l())
    this.listeners['hashchange']!.forEach((l) => l())
  }
  /** Let microtasks and the browser's queued history traversals run. */
  async settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    while (this.queue.length > 0) {
      this.queue.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  hashes(): string[] {
    return this.entries.map((e) => e.hash)
  }
}

let stop: (() => void) | null = null

function reset(): void {
  currentView.value = 'library'
  settingsOpen.value = false
  settingsTab.value = 'reading'
  practiceRequest.value = null
}

function start(hash = '', state: unknown = null): FakeBrowser {
  const created = new FakeBrowser(hash, state)
  stop = startRouter(created)
  return created
}

beforeEach(reset)
afterEach(() => {
  stop?.()
  stop = null
  reset()
  vi.useRealTimers()
})

describe('opening a URL', () => {
  it('shows the Library for an empty or unknown hash, without writing history', async () => {
    const b = start()
    await b.settle()
    expect(currentView.value).toBe('library')
    expect(b.writes).toEqual({ push: 0, replace: 0, back: 0 })
    stop?.()
    reset()
    const unknown = start('#/nonsense')
    expect(currentView.value).toBe('library')
    expect(unknown.hashes()).toEqual(['#/']) // rewritten in place, no new entry
  })

  it('reopens a deep-linked piece in Practice, an old link to its results too (U148)', async () => {
    start('#/practice/p1')
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toEqual({ pieceId: 'p1' })
    stop?.()
    reset()
    const b = start('#/results/p1/a2')
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toEqual({ pieceId: 'p1' })
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1']) // rewritten in place, no new entry
  })

  it.each(['#/study/p1', '#/consult/p1'])('opens the old link %s in Practice, in Listen (U141)', async (hash) => {
    const b = start(hash)
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toEqual({ pieceId: 'p1', mode: 'listen' })
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1']) // rewritten in place, no new entry
    expect(practiceRequest.value).toEqual({ pieceId: 'p1', mode: 'listen' })
  })

  it('opens an old link without a piece as Practice without one, and keeps an overlay', async () => {
    start('#/study')
    expect([currentView.value, practiceRequest.value]).toEqual(['practice', null])
    stop?.()
    reset()
    const b = start('#/study/p1?settings')
    expect([currentView.value, settingsOpen.value]).toEqual(['practice', true])
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1?settings'])
  })

  it('an old link typed while the same piece is open opens it in Listen; leaving Practice forgets that', async () => {
    const b = start('#/practice/p1')
    await b.settle()
    b.typeHash('#/study/p1')
    expect(practiceRequest.value).toEqual({ pieceId: 'p1', mode: 'listen' })
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1', '#/practice/p1'])
    // Settings over it and Back keep the screen that is open.
    const request = practiceRequest.value
    openSettings()
    await b.settle()
    b.history.back()
    await b.settle()
    expect(practiceRequest.value).toBe(request)
    navigate('library')
    await b.settle()
    b.history.back()
    await b.settle()
    expect([currentView.value, practiceRequest.value]).toEqual(['practice', { pieceId: 'p1' }])
  })

  it('ignores a Practice preset in history.state at boot and cleans it (a reload, U98); Back / Forward still apply it', async () => {
    const preset = { passage: { fromOcc: 3, toOcc: 6 }, hands: 'left' as const, multiplier: 0.6 }
    const b = start('#/practice/p1', { preset })
    expect(practiceRequest.value).toEqual({ pieceId: 'p1' })
    await b.settle()
    expect(b.entries).toEqual([{ hash: '#/practice/p1', state: {} }])
    // An entry with a preset reached by Back / Forward within the page applies it.
    openPractice({ pieceId: 'p2', preset })
    await b.settle()
    navigate('library')
    await b.settle()
    b.userBack()
    await b.settle()
    expect(practiceRequest.value).toEqual({ pieceId: 'p2', preset })
  })

  it('a reload into an overlay over a preset Practice entry keeps the overlay and its overlayFrom, without the preset', async () => {
    const preset = { passage: { fromOcc: 3, toOcc: 6 } }
    const b = start('#/practice/p1?settings', { preset, overlayFrom: true })
    expect(practiceRequest.value).toEqual({ pieceId: 'p1' })
    expect(settingsOpen.value).toBe(true)
    await b.settle()
    expect(b.entries).toEqual([{ hash: '#/practice/p1?settings', state: { overlayFrom: true } }])
  })

  it('a practice URL without a piece shows the view with no request (its empty state)', () => {
    start('#/practice')
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toBeNull()
  })

  it('opens a deep-linked overlay over its view, and the alias over the Library', () => {
    const b = start('#/practice/p1?settings')
    expect([currentView.value, settingsOpen.value, connectionOpen.value]).toEqual(['practice', true, false])
    stop?.()
    reset()
    const alias = start('#/connection')
    expect([currentView.value, connectionOpen.value]).toEqual(['library', true])
    expect(alias.hashes()).toEqual(['#/?connection']) // canonical form, same entry
    expect(b.entries).toHaveLength(1)
  })
})

describe('navigation → URL', () => {
  it('pushes an entry per page and Back / Forward walk between them with the preset intact', async () => {
    const b = start()
    const preset = { passage: { fromOcc: 1, toOcc: 4 }, hands: 'right' as const, multiplier: 0.8 }
    openPractice({ pieceId: 'p1', preset })
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/practice/p1'])
    expect(b.entries[1]!.state).toEqual({ preset })
    openPractice({ pieceId: 'p2' })
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/practice/p1', '#/practice/p2'])

    b.userBack()
    expect([currentView.value, practiceRequest.value]).toEqual(['practice', { pieceId: 'p1', preset }])
    b.userBack()
    expect(currentView.value).toBe('library')
    b.userForward()
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toEqual({ pieceId: 'p1', preset })
    await b.settle()
    expect(b.writes.push).toBe(2) // Back and Forward wrote nothing
    expect(b.writes.replace).toBe(0)
  })

  it('does not push twice for the same page', async () => {
    const b = start()
    navigate('library')
    await b.settle()
    openPractice({ pieceId: 'p1' })
    openPractice({ pieceId: 'p1' })
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/practice/p1'])
  })

  it('coalesces several signal writes in one tick into one history step', async () => {
    const b = start()
    openPractice({ pieceId: 'p1' })
    navigate('library')
    openPractice({ pieceId: 'p2' })
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/practice/p2'])
  })

  it('changing the preset of the open piece rewrites the entry instead of adding one', async () => {
    const b = start('#/practice/p1')
    openPractice({ pieceId: 'p1', preset: { hands: 'left' } })
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1'])
    expect(b.entries[0]!.state).toEqual({ preset: { hands: 'left' } })
    expect(b.writes.push).toBe(0)
  })

  it('opening another piece pushes', async () => {
    const b = start('#/practice/p1')
    openPractice({ pieceId: 'p2' })
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1', '#/practice/p2'])
  })

  it('a hand-typed hash drives the app', async () => {
    const b = start()
    b.typeHash('#/practice/p9')
    expect([currentView.value, practiceRequest.value]).toEqual(['practice', { pieceId: 'p9' }])
    b.typeHash('#/')
    expect(currentView.value).toBe('library')
    await b.settle()
    expect(b.writes).toEqual({ push: 0, replace: 0, back: 0 })
  })
})

describe('overlays and Back', () => {
  it('opening Settings pushes an entry; Back closes it', async () => {
    const b = start('#/practice/p1')
    openSettings()
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1', '#/practice/p1?settings'])
    b.userBack()
    expect(settingsOpen.value).toBe(false)
    expect(currentView.value).toBe('practice')
    b.userForward()
    expect(settingsOpen.value).toBe(true)
  })

  it('closing with the close button / Escape goes back, so history ends where it began', async () => {
    const b = start()
    openConnection()
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/?connection'])
    closeSettings()
    await b.settle()
    expect(b.index).toBe(0)
    expect(b.location.hash).toBe('')
    expect([connectionOpen.value, currentView.value]).toEqual([false, 'library'])
    expect(b.writes.back).toBe(1)
  })

  it('moving between Piano and sound and another tab rewrites the entry', async () => {
    const b = start()
    openConnection()
    await b.settle()
    settingsTab.value = 'app'
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/?settings'])
    expect([settingsOpen.value, connectionOpen.value]).toEqual([true, false])
    closeSettings()
    await b.settle()
    expect(b.index).toBe(0)
  })

  it('opening Settings again returns to Piano and sound when that tab was used last', async () => {
    const b = start('#/practice/p1')
    openConnection()
    await b.settle()
    closeSettings()
    await b.settle()
    openSettings()
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1', '#/practice/p1?connection'])
  })

  it('closeSettings(); openConnection() in one tick is one step', async () => {
    const b = start('#/practice/p1')
    openSettings()
    await b.settle()
    closeSettings()
    openConnection()
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1', '#/practice/p1?connection'])
    expect(b.writes.back).toBe(0)
    b.userBack()
    expect([connectionOpen.value, currentView.value]).toEqual([false, 'practice'])
  })

  it('closing an overlay that came from a deep link rewrites the entry (nothing to go back to)', async () => {
    const b = start('#/practice/p1?connection')
    closeSettings()
    await b.settle()
    expect(b.hashes()).toEqual(['#/practice/p1'])
    expect(b.writes.back).toBe(0)
    expect(b.entries).toHaveLength(1)
  })

  it('a reload keeps the overlay entry marked, so closing still goes back', async () => {
    const first = start()
    openSettings()
    await first.settle()
    const { hash, state } = first.entries[1]!
    stop?.()
    reset()
    const reloaded = start(hash, state) // new page load, same entry
    reloaded.entries.unshift({ hash: '', state: null })
    reloaded.index = 1
    expect(settingsOpen.value).toBe(true)
    closeSettings()
    await reloaded.settle()
    expect(reloaded.writes.back).toBe(1)
    expect(reloaded.index).toBe(0)
  })

  it('leaving the page closes the overlay and takes over its entry', async () => {
    const b = start()
    openSettings()
    await b.settle()
    openPractice({ pieceId: 'p1' }) // closes Settings and switches page together
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/practice/p1'])
    expect(settingsOpen.value).toBe(false)
    b.userBack()
    expect(currentView.value).toBe('library')
  })

  it('a page change that arrives while our own back() is pending still wins', async () => {
    const b = start()
    openSettings()
    await b.settle()
    closeSettings() // back() queued
    await Promise.resolve()
    await Promise.resolve()
    openPractice({ pieceId: 'p1' }) // before the browser has traversed
    await b.settle()
    expect(b.hashes()).toEqual(['', '#/practice/p1'])
    expect(b.location.hash).toBe('#/practice/p1')
    expect(currentView.value).toBe('practice')
  })

  it('gives up on a back() that never arrives and rewrites the entry instead', async () => {
    vi.useFakeTimers()
    const b = start()
    openSettings()
    await vi.advanceTimersByTimeAsync(0)
    expect(b.hashes()).toEqual(['', '#/?settings'])
    b.history.back = () => undefined // the browser drops the traversal
    closeSettings()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(b.location.hash).toBe('#/')
    expect(b.writes.replace).toBe(1)
  })

  it('follows the URL from one tab to the other and out', () => {
    const b = start('#/?settings')
    b.typeHash('#/?connection')
    expect([settingsOpen.value, connectionOpen.value]).toEqual([true, true])
    b.typeHash('#/')
    expect([settingsOpen.value, connectionOpen.value]).toEqual([false, false])
  })
})

describe('lifecycle', () => {
  it('stop removes the listeners and ignores later changes', async () => {
    const b = start()
    expect(b.listenerCount()).toBe(2)
    stop?.()
    stop = null
    expect(b.listenerCount()).toBe(0)
    openPractice({ pieceId: 'p1' })
    await b.settle()
    expect(b.hashes()).toEqual([''])
  })

  it('routeFromSignals describes the signals, naming Piano and sound apart', () => {
    openPractice({ pieceId: 'p1' })
    openConnection()
    expect(routeFromSignals()).toEqual({ view: 'practice', pieceId: 'p1', overlay: 'connection' })
    navigate('library')
    expect(routeFromSignals()).toEqual({ view: 'library', overlay: null })
  })

  it('survives history.pushState throwing (Safari caps history writes)', async () => {
    const b = start()
    b.history.pushState = () => {
      throw new DOMException('too many calls', 'SecurityError')
    }
    openPractice({ pieceId: 'p1' })
    await b.settle()
    expect(currentView.value).toBe('practice') // the app still works; only the URL lags
  })
})
