// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { resetAppStateForTests, updateSettings } from '../../app/state'
import { comparisonContext } from '../../core/history/testkit'
import type { PianissimoStorage } from '../../core/storage'
import { attemptFor, importPiece, openFresh } from '../../core/storage/testkit'
import { DEVICE_DATES, untranslatedText, usePseudoCatalog } from '../shared/catalogTesting'
import { sessionDismissals } from '../shared/suggestions'
import { $, $$, byText, click, mount, type Mounted } from '../shared/testing'
import { ProgressPanel } from './ProgressPanel'

const settle = (ms = 10) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!done() && Date.now() < end) await settle()
  expect(done()).toBe(true)
}

let view: Mounted | null = null
let storage: PianissimoStorage
const onPractice = vi.fn()
const onOpenSettings = vi.fn()

beforeEach(async () => {
  resetAppStateForTests()
  storage = await openFresh()
  sessionDismissals.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  view?.unmount()
  view = null
  storage.close()
})

const getStorage = () => Promise.resolve(storage)
async function open(pieceId: string): Promise<HTMLElement> {
  view = mount(
    <ProgressPanel pieceId={pieceId} storage={getStorage} onPractice={onPractice} onOpenSettings={onOpenSettings} />,
  )
  const root = view.container
  await until(() => !/Loading/.test(root.textContent ?? ''))
  return root
}
const button = (root: ParentNode, text: string) =>
  $$(root, 'button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined

describe('<ProgressPanel>', () => {
  it('says plainly when there is nothing in each section', async () => {
    const { piece } = await importPiece(storage, 'v1')
    const root = await open(piece.id)
    expect($$(root, 'h3').map((h) => h.textContent)).toEqual(['Work on next', 'Past passes'])
    expect(byText(root, 'Nothing to work on right now.')).not.toBeNull()
    expect(byText(root, 'No passes yet.')).not.toBeNull()
  })

  it('Work on next: hands a suggestion over, dismisses one, and is turned off and on for the piece', async () => {
    const { piece } = await importPiece(storage, 'v1')
    // Three error-bearing passes through bar 2 (occ 1) flag it. Queued: they are flushed first (RV7).
    for (let i = 0; i < 3; i += 1)
      storage.history.queueAttempt(attemptFor(piece.id, [[1, 'error']], { wrongAttacks: 1, passed: false }))
    const root = await open(piece.id)
    const card = $(root, '[data-suggestion]')!
    expect(card.textContent).toContain('Mistakes in bar 2 on 3 of your last 3 comparable passes.')
    click(button(card, 'Practice these bars'))
    expect(onPractice.mock.calls[0]![0]).toMatchObject({
      passage: { fromOcc: 0, toOcc: 2 },
      hands: 'both',
      multiplier: 1,
    })
    expect($$(root, '[data-context]')).toHaveLength(1)

    click(button(root, 'Not now'))
    await until(() => $(root, '[data-suggestion]') === null)
    expect($(root, '[data-state="none"]')).not.toBeNull()
    click(button(root, 'Turn off suggestions for this piece'))
    await until(() => $(root, '[data-state="disabled"]') !== null)
    expect((await storage.loadPieceHistory(piece.id)).disabled).toBe(true)
    click(button(root, 'Turn on suggestions'))
    await until(() => $(root, '[data-state="disabled"]') === null)
  })

  it('Work on next: points to Settings when suggestions are off there', async () => {
    const { piece } = await importPiece(storage, 'v1')
    updateSettings({ suggestions: { enabled: false } })
    const root = await open(piece.id)
    expect(root.textContent).toContain('switched off in Settings')
    expect(button(root, 'Turn on suggestions')).toBeUndefined()
    click(button(root, 'Open Settings'))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('Past passes: one row per context, the most recent first; a row unfolds to its history and a scorecard', async () => {
    const { piece } = await importPiece(storage, 'v1')
    const keepTime = comparisonContext({
      hands: 'right',
      multiplier: 0.75,
      transport: 'strict',
      matchingRules: 'strict-v1-tol-150ms',
    })
    const clean = attemptFor(piece.id, [[1, 'clean']], { createdAt: 1_000, completionTimeSec: 8.2 })
    const wrong = attemptFor(piece.id, [[1, 'error']], { createdAt: 2_000, wrongAttacks: 2, passed: false })
    const elsewhere = attemptFor(piece.id, [[1, 'clean']], {
      createdAt: 3_000,
      context: keepTime,
      completion: 'interrupted',
      interruptReason: 'pause',
    })
    await storage.addAttempts([clean, wrong, elsewhere])
    const root = await open(piece.id)
    const rows = $$(root, '[data-context]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Keep time · ±150 ms · Right hand at 0.75×')
    expect(rows[0]!.textContent).toContain('1 pass · No clean pass yet')
    expect(rows[0]!.textContent).toContain('Paused') // never timed (RV2)
    expect(rows[1]!.textContent).toContain('Bars 11–17')
    expect(rows[1]!.textContent).toContain('Wait · Both hands at 1×')
    expect(rows[1]!.textContent).toContain('2 passes · Best clean: 8.2 s')
    expect(rows[1]!.textContent).toContain('2 wrong attacks')

    const summary = $(rows[1]!, '[aria-expanded]')!
    click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    const history = $(rows[1]!, '[data-panel="history"]')!
    // Only this context's passes (RV1).
    expect($$(history, '[data-attempt]').map((b) => b.getAttribute('data-attempt'))).toEqual([clean.id, wrong.id])
    click($(history, `[data-attempt="${clean.id}"]`))
    expect($(rows[1]!, '[data-completion] h2')?.textContent).toBe('Earlier attempt')
    expect(history.closest('[hidden]')).not.toBeNull()
    click(button(rows[1]!, 'Back to these passes'))
    expect(history.closest('[hidden]')).toBeNull()
    expect(document.activeElement).toBe($(history, `[data-attempt="${clean.id}"]`))
  })

  it('shows no text that bypasses the catalogs', async () => {
    const { piece } = await importPiece(storage, 'v1')
    for (let i = 0; i < 3; i += 1)
      storage.history.queueAttempt(attemptFor(piece.id, [[1, 'error']], { wrongAttacks: 1, passed: false }))
    await storage.history.flush()
    const restore = usePseudoCatalog()
    try {
      view = mount(
        <ProgressPanel
          pieceId={piece.id}
          storage={getStorage}
          onPractice={onPractice}
          onOpenSettings={onOpenSettings}
        />,
      )
      const root = view.container
      await until(() => $(root, '[data-suggestion]') !== null && $(root, '[data-context]') !== null)
      click($(root, '[data-context] [aria-expanded]'))
      expect(untranslatedText(root, DEVICE_DATES)).toEqual([])
    } finally {
      restore()
    }
  })
})
