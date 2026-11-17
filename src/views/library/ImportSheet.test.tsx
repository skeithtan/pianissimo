// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { fixtureBytes } from '../../../tests/unit/import/fixtures'
import { existingAudioContext, resetSharedAudioContext } from '../../core/playback/webaudio/context'
import { $, $$, byLabel, byText, click, mount, type, type Mounted } from '../shared/testing'
import { ImportSheet } from './ImportSheet'
import { ImportFlow, resetPersistenceRequestForTests, type FlowPhase } from './importFlow'
import { initialDraft } from './review'
import { bytesFile, testDeps, type TestDeps } from './testkit'

let view: Mounted | null = null
let deps: TestDeps
let flow: ImportFlow

beforeEach(async () => {
  resetPersistenceRequestForTests()
  deps = await testDeps()
  flow = new ImportFlow(deps)
})

afterEach(() => {
  view?.unmount()
  view = null
  flow.close()
  resetSharedAudioContext()
})

const file = (name: string) => bytesFile(name, fixtureBytes(name))
const review = (): Extract<FlowPhase, { kind: 'review' }> => {
  const phase = flow.phase.peek()
  if (phase.kind !== 'review') throw new Error('Expected the import review')
  return phase
}
const button = (root: ParentNode, label: string) => byLabel(root, label) as HTMLButtonElement
const details = (root: ParentNode) => byText(root, 'Import details', 'summary')?.parentElement as HTMLDetailsElement

async function open(name = 'two-hands.musicxml', onOpenExisting = vi.fn()) {
  await flow.openFile(file(name))
  const pieces = await deps.storage.listPieces()
  view = mount(<ImportSheet flow={flow} pieces={pieces} onClose={() => flow.close()} onOpenExisting={onOpenExisting} />)
  return view.container
}

describe('Import review', () => {
  it('opens a ready score with a short summary and optional report, without priming audio', async () => {
    const root = await open()
    expect(root.textContent).toContain('Ready to open')
    expect(button(root, 'Add and open').disabled).toBe(false)
    expect(details(root).open).toBe(false)
    expect(byText(root, 'Notes', 'dt')?.closest('details')).toBe(details(root))
    expect(button(root, 'Change hands').closest('details')).toBe(details(root))
    expect(existingAudioContext()).toBeNull()
    await act(async () => {
      click(button(root, 'Add and open'))
      await vi.waitFor(async () => expect(await deps.storage.listPieces()).toHaveLength(1))
    })
    expect(existingAudioContext()).toBeNull()
  })

  it('keeps missing tempo and beat unit visible and blocks saving until valid', async () => {
    const root = await open('no-tempo.musicxml')
    const tempo = byLabel(root, 'Beats per minute')
    expect(tempo?.closest('details')).toBeNull()
    expect(root.textContent).not.toContain('Before you play')
    expect(byLabel(root, 'Beat unit')?.closest('details')).toBeNull()
    expect(button(root, 'Add and open').disabled).toBe(true)
    type(tempo, '12')
    expect(button(root, 'Add and open').disabled).toBe(true)
    type(tempo, '84')
    expect(button(root, 'Add and open').disabled).toBe(false)
  })

  it('keeps an ambiguous hand assignment above the optional report until confirmed', async () => {
    const root = await open('split-voice.musicxml')
    const confirm = button(root, 'Confirm hands')
    expect(confirm.closest('details')).toBeNull()
    expect(button(root, 'Add and open').disabled).toBe(true)
    click(confirm)
    expect(button(root, 'Add and open').disabled).toBe(false)
  })

  it('shows consequential warnings without opening the technical report', async () => {
    const root = await open('timing-marks.musicxml')
    const issue = $$(root, 'li').find((item) => item.textContent?.startsWith('Timing is not scored across'))
    expect(issue).toBeDefined()
    expect(issue?.closest('details')).toBeNull()
    expect(details(root).open).toBe(false)
  })

  it('keeps import errors visible and refuses to add the score', async () => {
    await flow.openFile(file('two-hands.musicxml'))
    const phase = review()
    flow.phase.value = {
      ...phase,
      result: {
        ...phase.result,
        summary: {
          ...phase.result.summary,
          diagnostics: {
            ...phase.result.summary.diagnostics,
            errors: 1,
            list: [{ severity: 'error', code: 'test-error', message: 'A note could not be read.' }],
          },
        },
      },
    }
    view = mount(<ImportSheet flow={flow} pieces={[]} onClose={() => flow.close()} />)
    const root = view.container
    expect(byText(root, 'A note could not be read.', 'li')?.closest('details')).toBeNull()
    expect(button(root, 'Add and open').disabled).toBe(true)
  })

  it('offers an existing duplicate first without editable shared settings', async () => {
    await flow.openFile(file('no-tempo.musicxml'))
    const first = review()
    await flow.save({ ...initialDraft(first.result.summary, first.result.package.model), bpmText: '84' })
    const existing = (await deps.storage.listPieces())[0]!
    const onOpenExisting = vi.fn()
    const root = await open('no-tempo.musicxml', onOpenExisting)
    expect(button(root, 'Open existing piece').disabled).toBe(false)
    expect(byLabel(root, 'Beats per minute')).toBeNull()
    expect($(root, '[aria-label="Hands"]')).toBeNull()
    expect(byLabel(root, 'Add and open')).toBeNull()
    click(button(root, 'Open existing piece'))
    expect(onOpenExisting).toHaveBeenCalledWith(existing.id)
    expect(await deps.storage.listPieces()).toHaveLength(1)
  })
})
