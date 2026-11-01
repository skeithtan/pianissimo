// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { fixtureBytes } from '../../../tests/unit/import/fixtures'
import { existingAudioContext, resetSharedAudioContext } from '../../core/playback/webaudio/context'
import { currentView, practiceRequest, settingsOpen } from '../../app/navigation'
import { notices, resetAppStateForTests, updateSettings } from '../../app/state'
import { attemptFor, importPiece } from '../../core/storage/testkit'
import { $, $$, byLabel, byText, click, mount, type, type Mounted } from '../shared/testing'
import { Library } from './LibraryView'
import { resetPersistenceRequestForTests } from './importFlow'
import { sessionDismissals } from './suggestionsData'
import { bytesFile, testDeps, tick, type TestDeps } from './testkit'

let view: Mounted | null = null
let deps: TestDeps

const settle = (ms = 20) =>
  act(async () => {
    await tick(ms)
  })

/** Wait (in act) until `check` passes, up to ~2 s. */
async function until(check: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await settle(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeEach(async () => {
  resetAppStateForTests()
  resetPersistenceRequestForTests()
  sessionDismissals.clear()
  practiceRequest.value = null
  currentView.value = 'library'
  settingsOpen.value = false
  deps = await testDeps()
})
afterEach(() => {
  view?.unmount()
  view = null
  resetAppStateForTests()
  resetSharedAudioContext()
  vi.unstubAllGlobals()
})

async function open(): Promise<HTMLElement> {
  view = mount(<Library deps={deps} />)
  await settle()
  return view.container
}

/** Pick a file through a FileButton (the label's hidden input). */
function pick(button: HTMLElement | null, file: File): void {
  const input = button?.querySelector('input[type="file"]') as HTMLInputElement | null
  if (!input) throw new Error('no file input')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const fileButton = (root: HTMLElement, text: string) =>
  $$(root, 'label').find((l) => l.textContent?.trim() === text) ?? null
/** Piece titles in the list (sheet headings excluded). */
const titles = (root: HTMLElement) =>
  $$(root, 'li h2')
    .filter((h) => !h.closest('dialog'))
    .map((h) => h.textContent)
const fixture = (name: string) => bytesFile(name, fixtureBytes(name))
const dialog = (root: HTMLElement) => ($$(root, 'dialog') as HTMLDialogElement[]).find((d) => d.open) ?? null
const button = (root: ParentNode, text: string) =>
  $$(root as HTMLElement, 'button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined

describe('Library list', () => {
  it('shows a clear empty state with the import call to action, and no backup tools', async () => {
    const root = await open()
    expect(byText(root, 'Your library is empty')).not.toBeNull()
    expect(fileButton(root, 'Import MusicXML')).not.toBeNull()
    const input = fileButton(root, 'Import MusicXML')!.querySelector('input')!
    expect(input.getAttribute('accept')).toContain('.musicxml')
    expect(input.getAttribute('accept')).toContain('.mxl')
    // Backup and restore live in Settings → Backup.
    expect(button(root, 'Export backup')).toBeUndefined()
    expect(fileButton(root, 'Restore from backup…')).toBeNull()
    expect(root.textContent).toContain('Settings → Backup')
  })

  it('refreshes the list when Settings close (a restore there may have added pieces)', async () => {
    settingsOpen.value = true
    const root = await open()
    await importPiece(deps.storage, 'v2', { title: 'Restored' })
    settingsOpen.value = false
    await until(() => titles(root).includes('Restored'), 'refreshed')
  })

  it('accepts any file on iPad (content is sniffed)', async () => {
    deps = { ...deps, isAppleMobile: () => true }
    const root = await open()
    expect(fileButton(root, 'Import MusicXML')!.querySelector('input')!.hasAttribute('accept')).toBe(false)
  })

  it('lists pieces latest first with composer, last opened and last speed, and opens one in Practice', async () => {
    await importPiece(deps.storage, 'v1', {
      title: 'Etude',
      lastOpenedAt: deps.clock - 2 * 86_400_000,
      lastMultiplier: 0.75,
    })
    await importPiece(deps.storage, 'v2', { title: 'Nocturne', lastOpenedAt: deps.clock - 60_000 })
    const root = await open()
    expect(titles(root)).toEqual(['Nocturne', 'Etude'])
    expect(root.textContent).toContain('Opened 1 minute ago')
    expect(root.textContent).toContain('Opened 2 days ago')
    expect(root.textContent).toContain('75% speed')
    expect(root.textContent).toContain('Anon')

    deps.clock += 5000
    click(byLabel(root, 'Practice Etude'))
    await until(() => currentView.value === 'practice', 'navigation')
    expect(practiceRequest.value).toEqual({ pieceId: 'piece-v1' })
    expect((await deps.storage.getPiece('piece-v1'))?.lastOpenedAt).toBe(deps.clock)
  })

  it('explains when storage cannot be opened', async () => {
    deps = { ...deps, getStorage: () => Promise.reject(new Error('blocked')) }
    const root = await open()
    expect(root.textContent).toMatch(/does not allow saving/)
    const input = fileButton(root, 'Import MusicXML')!.querySelector('input')!
    expect(input.disabled).toBe(true)
  })

  it('deletes a piece only after confirmation, with its results', async () => {
    const { piece } = await importPiece(deps.storage, 'v1', { title: 'Etude' })
    await deps.storage.addAttempts([attemptFor(piece.id, [[1, 'clean']])])
    const root = await open()
    click(button(root, 'Delete…'))
    await settle()
    const d = dialog(root)!
    expect(d.textContent).toMatch(/cannot be undone/)
    click(button(d, 'Keep it'))
    await settle(250)
    expect(await deps.storage.listPieces()).toHaveLength(1)

    click(button(root, 'Delete…'))
    await settle()
    click(button(dialog(root)!, 'Delete piece'))
    await until(() => byText(root, 'Your library is empty') !== null, 'empty library')
    expect(await deps.storage.listPieces()).toEqual([])
    expect(await deps.storage.listAttempts({ pieceId: piece.id })).toEqual([])
    expect(notices.value.some((n) => n.text === 'Deleted “Etude”.')).toBe(true)
  })

  it('clears practice history, optionally with results (ST5)', async () => {
    const { piece } = await importPiece(deps.storage, 'v1', { title: 'Etude' })
    for (let i = 0; i < 3; i++) deps.storage.history.queueAttempt(attemptFor(piece.id, [[1, 'error']]))
    await deps.storage.history.flush()
    expect((await deps.storage.loadPieceHistory(piece.id)).suggestions).toHaveLength(1)
    const root = await open()

    click(button(root, 'Clear practice history…'))
    await settle()
    let d = dialog(root)!
    click(button(d, 'Clear history'))
    await until(() => notices.value.some((n) => /Cleared the practice history of/.test(n.text)), 'notice')
    expect((await deps.storage.loadPieceHistory(piece.id)).suggestions).toHaveLength(0)
    expect(await deps.storage.listAttempts({ pieceId: piece.id })).toHaveLength(3) // results kept

    await settle(250)
    click(button(root, 'Clear practice history…'))
    await settle()
    d = dialog(root)!
    const box = $(d, 'input[type="checkbox"]') as HTMLInputElement
    act(() => box.click())
    click(button(d, 'Clear history and results'))
    await until(() => notices.value.some((n) => /and results/.test(n.text)), 'notice')
    expect(await deps.storage.listAttempts({ pieceId: piece.id })).toHaveLength(0)
  })
})

describe('Import flow (UI)', () => {
  it('imports a ready score and opens it in Practice with an automatic start request', async () => {
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('two-hands.musicxml'))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
    const d = dialog(root)!
    expect(d.getAttribute('aria-label')).toBe('Import MusicXML')
    expect(d.textContent).toContain('Hands')
    expect(d.textContent).toContain('From the score')
    expect(d.textContent).toContain('Score check')
    expect(button(d, 'Add to library')!.disabled).toBe(false)
    click(button(d, 'Add to library'))
    // Saving closes the sheet and opens the stored score, without waiting for persistence.
    await until(() => notices.value.some((n) => /“Two Hands” is in your library\./.test(n.text)), 'saved')
    await until(() => dialog(root) === null, 'sheet closed')
    await until(() => titles(root).length === 1, 'list')
    expect(deps.manager.persistCalls).toBe(1) // persistent storage still requested after the first import
    const pieces = await deps.storage.listPieces()
    expect(pieces).toHaveLength(1)
    expect(currentView.value).toBe('practice')
    expect(practiceRequest.value).toEqual({ pieceId: pieces[0]!.id, autoStart: true })
  })

  it('unlocks browser sound in the Add click before saving and opening Practice', async () => {
    const resume = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'suspended'
        resume = resume
      },
    )
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('two-hands.musicxml'))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
    expect(existingAudioContext()).toBeNull()
    click(button(dialog(root)!, 'Add to library'))
    expect(existingAudioContext()).not.toBeNull()
    expect(resume).toHaveBeenCalledOnce()
    await until(() => currentView.value === 'practice', 'practice')
  })

  it('keeps Add to library disabled until a split voice is confirmed', async () => {
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('split-voice.musicxml'))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
    const d = dialog(root)!
    expect(button(d, 'Add to library')!.disabled).toBe(true)
    expect(d.textContent).toContain('Needs your confirmation')
    expect(d.textContent).toMatch(/Choose which hand plays voice 2/)
    expect(d.textContent).toContain('Split between staves')
    // Choose the right hand for voice 2, then confirm.
    const group = byLabel(d, 'Hand for Voice 2')!
    click($$(group, '[role="radio"]').find((b) => b.textContent === 'Right hand'))
    click(button(d, 'Confirm hands'))
    expect(d.textContent).toContain('From the score')
    expect(d.textContent).toMatch(/Right hand\s*Voice 1 and voice 2/)
    expect(button(d, 'Add to library')!.disabled).toBe(false)
    click(button(d, 'Add to library'))
    await until(() => notices.value.some((n) => /is in your library/.test(n.text)), 'saved')
    const [piece] = await deps.storage.listPieces()
    const pkg = await deps.storage.getPackage(piece!.scoreVersionId)
    expect(pkg?.model.hands.byVoice['P1:2']).toBe('R')
  })

  it('shows a cross-staff voice as one hand with no confirmation, and lets the user change it', async () => {
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('cross-staff.musicxml'))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
    const d = dialog(root)!
    expect(button(d, 'Add to library')!.disabled).toBe(false)
    expect(button(d, 'Confirm hands')).toBeUndefined()
    expect(d.textContent).toContain('From the score')
    expect(d.textContent).toMatch(/Left hand\s*Voice 5 · 8 notes/)
    expect(d.textContent).toMatch(/Voice 5 stays one hand: 2 notes written on the upper staff in bar 2\./)
    expect(byLabel(d, 'Hand for Voice 5')).toBeNull()
    click(button(d, 'Change hands'))
    const group = byLabel(d, 'Hand for Voice 5')!
    click($$(group, '[role="radio"]').find((b) => b.textContent === 'Right hand'))
    click(button(d, 'Done'))
    expect(d.textContent).toMatch(/Right hand\s*Voice 1 and voice 5 · 10 notes/)
    click(button(d, 'Add to library'))
    await until(() => notices.value.some((n) => /is in your library/.test(n.text)), 'saved')
    const [piece] = await deps.storage.listPieces()
    const pkg = await deps.storage.getPackage(piece!.scoreVersionId)
    expect(pkg?.model.hands).toMatchObject({ confirmed: true, byVoice: { 'P1:1': 'R', 'P1:5': 'R' } })
  })

  it('requires a practice tempo for a score without one', async () => {
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('no-tempo.musicxml'))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
    const d = dialog(root)!
    expect(d.textContent).toContain('Practice tempo')
    expect(d.textContent).toContain('Required')
    expect(button(d, 'Add to library')!.disabled).toBe(true)
    const input = byLabel(d, 'Beats per minute') as HTMLInputElement
    type(input, '500')
    expect(d.textContent).toMatch(/between 20 and 300/)
    type(input, '80')
    expect(d.querySelector('[role="alert"]')).toBeNull()
    click($$(byLabel(d, 'Beat unit')!, '[role="radio"]').find((b) => b.textContent === 'Half'))
    click(button(d, 'Add to library'))
    await until(() => notices.value.some((n) => /is in your library/.test(n.text)), 'saved')
    const [piece] = await deps.storage.listPieces()
    expect(piece?.userTempo).toEqual({ beatBpm: 80, beatUnit: { n: 1, d: 2 } })
  })

  it('asks which part is the piano, then can go back to change it', async () => {
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('two-parts.musicxml'))
    await until(() => button(root, 'Continue') !== undefined, 'choice')
    const d = dialog(root)!
    expect(d.textContent).toContain('Which part is the piano?')
    const boxes = $$(d, 'input[type="checkbox"]') as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([false, true, true])
    click(button(d, 'Continue'))
    await until(() => button(root, 'Change parts') !== undefined, 'summary')
    click(button(dialog(root)!, 'Change parts'))
    await until(() => button(root, 'Continue') !== undefined, 'choice again')
  })

  it('cancels a running import: the sheet closes and the late result never shows', async () => {
    deps.client.hold = true
    deps.client.lateResults = true
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('two-hands.musicxml'))
    await until(() => button(root, 'Cancel import') !== undefined, 'progress')
    expect($(root, '[role="progressbar"]')).not.toBeNull()
    click(button(root, 'Cancel import'))
    await settle(300)
    expect(dialog(root)).toBeNull()
    deps.client.releaseAll()
    await settle(100)
    expect(dialog(root)).toBeNull()
    expect(button(root, 'Add to library')).toBeUndefined()
    expect(deps.client.disposed).toBeGreaterThan(0)
  })

  it('explains a rejected file and offers another pick', async () => {
    const root = await open()
    pick(fileButton(root, 'Import MusicXML'), fixture('unrelated.xml'))
    await until(() => /could not be imported/.test(dialog(root)?.textContent ?? ''), 'failure')
    const d = dialog(root)!
    expect(fileButton(d, 'Choose another file')).not.toBeNull()
    pick(fileButton(d, 'Choose another file'), fixture('two-hands.musicxml'))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
  })
})

describe('Review hands and tempo of a stored piece (L5)', () => {
  async function importThroughSheet(root: HTMLElement, name: string, bpm?: string) {
    pick(fileButton(root, 'Import MusicXML'), fixture(name))
    await until(() => button(root, 'Add to library') !== undefined, 'summary')
    const d = dialog(root)!
    if (button(d, 'Confirm hands')) click(button(d, 'Confirm hands'))
    if (bpm) type(byLabel(d, 'Beats per minute'), bpm)
    click(button(d, 'Add to library'))
    await until(() => notices.value.some((n) => /is in your library/.test(n.text)), 'saved')
    await settle(250)
    const [piece] = await deps.storage.listPieces()
    return piece!
  }

  it('reassigns a voice to the other hand: same score version, new package hands, layouts dropped', async () => {
    const root = await open()
    const piece = await importThroughSheet(root, 'cross-staff.musicxml')
    const before = (await deps.storage.getPackage(piece.scoreVersionId))!
    const voiceHand = before.model.hands.byVoice['P1:5']
    await deps.storage.putLayout('layout-key', piece.scoreVersionId, { any: 1 } as never, 10)
    expect(await deps.storage.getLayout('layout-key')).toBeDefined()

    click(button(root, 'Review hands and tempo…'))
    await until(() => button(dialog(root) ?? root, 'Save changes') !== undefined, 'review')
    const d = dialog(root)!
    expect(d.getAttribute('aria-label')).toBe(`Hands and tempo of “${piece.title}”`)
    expect(d.textContent).toMatch(/separate practice history/)
    expect(d.textContent).toContain('From the score') // the score's own tempo is not editable
    expect(button(d, 'Save changes')!.disabled).toBe(true) // nothing changed yet
    const other = voiceHand === 'L' ? 'Right hand' : 'Left hand'
    click($$(byLabel(d, 'Hand for Voice 5')!, '[role="radio"]').find((b) => b.textContent === other))
    expect(button(d, 'Save changes')!.disabled).toBe(false)
    click(button(d, 'Save changes'))
    await until(() => notices.value.some((n) => /Saved the hands of/.test(n.text)), 'saved notice')

    const [after] = await deps.storage.listPieces()
    expect(after!.id).toBe(piece.id)
    expect(after!.scoreVersionId).toBe(piece.scoreVersionId)
    const pkg = (await deps.storage.getPackage(piece.scoreVersionId))!
    expect(pkg.model.hands.byVoice['P1:5']).toBe(voiceHand === 'L' ? 'R' : 'L')
    expect(await deps.storage.getLayout('layout-key')).toBeUndefined()
    expect(await deps.storage.getSource(piece.scoreVersionId)).toBeDefined()
  })

  it('changes a practice tempo the user entered, validated like at import', async () => {
    const root = await open()
    await importThroughSheet(root, 'no-tempo.musicxml', '80')
    click(button(root, 'Review hands and tempo…'))
    await until(() => button(dialog(root) ?? root, 'Save changes') !== undefined, 'review')
    const d = dialog(root)!
    const input = byLabel(d, 'Beats per minute') as HTMLInputElement
    expect(input.value).toBe('80')
    type(input, '500')
    expect(d.textContent).toMatch(/between 20 and 300/)
    expect(button(d, 'Save changes')!.disabled).toBe(true)
    type(input, '96')
    click(button(d, 'Save changes'))
    await until(() => notices.value.some((n) => /Saved the practice tempo of/.test(n.text)), 'saved notice')
    const [piece] = await deps.storage.listPieces()
    expect(piece!.userTempo).toEqual({ beatBpm: 96, beatUnit: { n: 1, d: 4 } })
    const pkg = (await deps.storage.getPackage(piece!.scoreVersionId))!
    expect(pkg.model.tempo.segments[0]).toMatchObject({ beatBpm: 96, source: 'user' })
    expect(root.textContent).toContain('Your tempo: quarter = 96')
  })
})

describe('Suggested practice (Library)', () => {
  async function withSuggestion() {
    const { piece } = await importPiece(deps.storage, 'v1', { title: 'Etude' })
    for (let i = 0; i < 3; i++)
      deps.storage.history.queueAttempt(
        attemptFor(piece.id, [
          [1, 'error'],
          [2, 'clean'],
        ]),
      )
    await deps.storage.history.flush()
    return piece
  }

  it('shows evidence, bars with context, progress and opens Practice with the preset', async () => {
    const piece = await withSuggestion()
    const root = await open()
    await until(() => button(root, 'Practice this passage') !== undefined, 'suggestion')
    expect(root.textContent).toMatch(/Mistakes in bar 2 on 3 of your last 3 comparable passes/)
    expect(root.textContent).toContain('Both hands')
    expect(root.textContent).toContain('1× speed')
    expect(root.textContent).toMatch(/0 of 3 clean passes/)
    const bars = $$(root, '[data-role]')
    expect(bars.map((b) => b.getAttribute('data-role'))).toEqual(['context', 'difficult', 'context'])

    click(button(root, 'Practice this passage'))
    await until(() => currentView.value === 'practice', 'navigation')
    expect(practiceRequest.value).toEqual({
      pieceId: piece.id,
      preset: { passage: { fromOcc: 0, toOcc: 2 }, hands: 'both', multiplier: 1 },
    })
  })

  it('dismisses for this session only, and can be turned off and on for the piece', async () => {
    const piece = await withSuggestion()
    let root = await open()
    await until(() => button(root, 'Not now') !== undefined, 'suggestion')
    click(button(root, 'Not now'))
    await until(() => /Nothing to suggest right now/.test(root.textContent ?? ''), 'dismissed')
    // Still dismissed when the Library is opened again in this session.
    view!.unmount()
    root = await open()
    await until(() => /Nothing to suggest right now/.test(root.textContent ?? ''), 'still dismissed')
    sessionDismissals.clear()

    click(button(root, 'Turn off suggestions for this piece'))
    await until(() => /Suggested practice is turned off/.test(root.textContent ?? ''), 'disabled')
    expect((await deps.storage.loadPieceHistory(piece.id)).disabled).toBe(true)
    click(button(root, 'Turn on suggestions'))
    await until(() => button(root, 'Practice this passage') !== undefined, 'enabled again')
  })

  it('says when suggestions are off in Settings', async () => {
    await withSuggestion()
    await deps.storage.saveSettings({
      ...(await deps.storage.loadSettings()),
      suggestions: { enabled: false },
    } as never)
    updateSettings({ suggestions: { enabled: false } } as never)
    const root = await open()
    await until(() => /turned off in Settings/.test(root.textContent ?? ''), 'global off')
  })
})
