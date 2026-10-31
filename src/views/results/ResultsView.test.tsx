// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { currentView, practiceRequest, resultsRequest } from '../../app/navigation'
import { resetServicesForTests } from '../../app/services'
import { resetAppStateForTests, updateSettings } from '../../app/state'
import { comparisonContext } from '../../core/history/testkit'
import type { PianissimoStorage } from '../../core/storage'
import { attemptFor, importPiece, openFresh } from '../../core/storage/testkit'
import { sessionDismissals } from '../shared/suggestions'
import { $, $$, byText, click, mount, type Mounted } from '../shared/testing'
import { ResultsView } from './ResultsView'

const settle = (ms = 40) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

let view: Mounted | null = null
let storage: PianissimoStorage

beforeEach(async () => {
  resetAppStateForTests()
  storage = await openFresh()
  resetServicesForTests({ openStorage: () => Promise.resolve(storage) })
  resultsRequest.value = null
  practiceRequest.value = null
  currentView.value = 'results'
  sessionDismissals.clear()
})
afterEach(() => {
  view?.unmount()
  view = null
  resetServicesForTests()
  storage.close()
  resultsRequest.value = null
  practiceRequest.value = null
})

/** Wait (polling) until `done()` holds; storage work finishes in a few macrotasks under load. */
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!done() && Date.now() < end) await settle(10)
  await settle(0)
}

async function open(): Promise<HTMLElement> {
  view = mount(<ResultsView />)
  const root = view.container
  await settle(0)
  await until(() => root.querySelector('[aria-busy]') === null)
  return root
}

describe('<ResultsView>', () => {
  it('without a request shows an empty state linking to the Library', async () => {
    const root = await open()
    expect($(root, '[data-state="no-request"]')).not.toBeNull()
    click(byText(root, 'Go to the Library', 'button span')?.closest('button'))
    expect(currentView.value).toBe('library')
  })

  it('says so when the piece is gone', async () => {
    resultsRequest.value = { pieceId: 'nope' }
    const root = await open()
    expect($(root, '[data-state="missing"]')?.textContent).toContain('no longer in your library')
  })

  it('shows the most recent stored attempt and flushes queued records first', async () => {
    const { piece } = await importPiece(storage, 'v1')
    // Queued in the writer, not yet in IndexedDB: the view must flush before reading.
    storage.history.queueAttempt(attemptFor(piece.id, [[1, 'clean']], { createdAt: 5_000, wrongAttacks: 0 }))
    storage.history.queueAttempt(
      attemptFor(piece.id, [[1, 'error']], { createdAt: 9_000, wrongAttacks: 4, passed: false, groupsFirstPass: 4 }),
    )
    resultsRequest.value = { pieceId: piece.id }
    const root = await open()
    expect($(root, 'h1')?.textContent).toBe('Results')
    expect(root.textContent).toContain(piece.title)
    expect($(root, '[data-row="wrong-attacks"] dd')?.textContent).toContain('4')
    expect($$(root, '[data-panel="history"] [data-attempt]')).toHaveLength(2)
    expect($(root, '[data-row="context"]')?.textContent).toContain('Bars 11–17')
  })

  it('shows a requested attempt, compares only within its context, and keeps other contexts separate', async () => {
    const { piece } = await importPiece(storage, 'v1')
    const other = comparisonContext({ hands: 'right', multiplier: 0.75 })
    const mine = attemptFor(piece.id, [[1, 'clean']], { createdAt: 1_000 })
    const mineLater = attemptFor(piece.id, [[1, 'clean']], { createdAt: 2_000 })
    const elsewhere = attemptFor(piece.id, [[1, 'clean']], { createdAt: 3_000, context: other })
    await storage.addAttempts([mine, mineLater, elsewhere])
    resultsRequest.value = { pieceId: piece.id, attemptId: mine.id }
    const root = await open()
    expect($(root, 'h2')?.textContent).toBe('Earlier attempt')
    expect($(root, '[data-row="context"]')?.textContent).toContain('Both hands at 1×')
    expect(
      $$(root, '[data-panel="history"] [data-attempt]')
        .map((b) => b.getAttribute('data-attempt'))
        .sort(),
    ).toEqual([mine.id, mineLater.id].sort())
    expect($(root, '[data-panel="others"]')?.textContent).toContain('Right hand at 0.75×')
  })

  it('Practice again opens Practice with the attempt’s passage, hands and speed preselected', async () => {
    const { piece } = await importPiece(storage, 'v1')
    const ctx = comparisonContext({
      hands: 'left',
      multiplier: 0.5,
      transport: 'accompaniment',
      passage: { fromOcc: 1, toOcc: 3 },
    })
    await storage.addAttempts([attemptFor(piece.id, [[1, 'clean']], { context: ctx })])
    resultsRequest.value = { pieceId: piece.id }
    const root = await open()
    click(byText(root, 'Practice again', 'button span')?.closest('button'))
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toEqual({
      pieceId: piece.id,
      preset: { passage: { fromOcc: 1, toOcc: 3 }, hands: 'left', multiplier: 0.5 },
    })
  })

  it('lists suggestions; Practice this passage preselects the range without starting', async () => {
    const { piece } = await importPiece(storage, 'v1')
    // Three error-bearing passes through bar 2 (occ 1) flag it.
    for (let i = 0; i < 3; i += 1)
      storage.history.queueAttempt(attemptFor(piece.id, [[1, 'error']], { wrongAttacks: 1, passed: false }))
    resultsRequest.value = { pieceId: piece.id }
    const root = await open()
    const card = $(root, '[data-suggestion]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Mistakes in bar 2 on 3 of your last 3 comparable passes.')
    click(byText(card as HTMLElement, 'Practice this passage', 'button span')?.closest('button'))
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value?.preset).toEqual({ passage: { fromOcc: 0, toOcc: 2 }, hands: 'both', multiplier: 1 })
  })

  it('dismisses a suggestion for the session and can turn suggestions off for the piece', async () => {
    const { piece } = await importPiece(storage, 'v1')
    for (let i = 0; i < 3; i += 1)
      storage.history.queueAttempt(attemptFor(piece.id, [[1, 'error']], { wrongAttacks: 1, passed: false }))
    resultsRequest.value = { pieceId: piece.id }
    const root = await open()
    const id = $(root, '[data-suggestion]')?.getAttribute('data-suggestion')
    click(byText(root, 'Not now', 'button span')?.closest('button'))
    await until(() => $(root, '[data-suggestion]') === null)
    expect(sessionDismissals.has(id ?? '')).toBe(true)
    expect($(root, '[data-suggestion]')).toBeNull()
    expect($(root, '[data-state="none"]')).not.toBeNull()

    click(byText(root, 'Turn off suggestions for this piece', 'button span')?.closest('button'))
    await until(() => $(root, '[data-state="disabled"]') !== null)
    expect($(root, '[data-state="disabled"]')).not.toBeNull()
    click(byText(root, 'Turn on suggestions', 'button span')?.closest('button'))
    await until(() => $(root, '[data-state="disabled"]') === null)
    expect($(root, '[data-state="disabled"]')).toBeNull()
  })

  it('honors the global switch from Settings', async () => {
    const { piece } = await importPiece(storage, 'v1')
    await storage.addAttempts([attemptFor(piece.id, [[1, 'clean']])])
    updateSettings({ suggestions: { enabled: false } })
    resultsRequest.value = { pieceId: piece.id }
    const root = await open()
    expect($(root, '[data-state="disabled"]')).not.toBeNull()
    expect(root.textContent).toContain('switched off in Settings')
  })

  it('shows the empty attempts state for a piece with no records', async () => {
    const { piece } = await importPiece(storage, 'v1')
    resultsRequest.value = { pieceId: piece.id }
    const root = await open()
    expect($(root, '[data-state="no-attempts"]')).not.toBeNull()
    click(byText(root, 'Open Practice', 'button span')?.closest('button'))
    expect(practiceRequest.value).toEqual({ pieceId: piece.id })
  })
})
