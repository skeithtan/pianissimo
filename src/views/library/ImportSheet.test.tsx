// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'preact/test-utils'
import { fixtureBytes } from '../../../tests/unit/import/fixtures'
import { existingAudioContext, resetSharedAudioContext } from '../../core/playback/webaudio/context'
import { $, $$, byLabel, byText, click, mount, type, type Mounted } from '../shared/testing'
import { untranslatedText, useCatalog, usePseudoCatalog } from '../shared/catalogTesting'
import { msg } from '../../i18n/messages'
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

describe('translation coverage', () => {
  const scores = [
    'two-hands.musicxml',
    'no-tempo.musicxml',
    'split-voice.musicxml',
    'cross-staff.musicxml',
    'timing-marks.musicxml',
    'tempo-changes.musicxml',
    'tempo-conflict.musicxml',
    'changes.musicxml',
    'ottava.musicxml',
    'rolls.musicxml',
    'repeats.musicxml',
    'ds-al-coda.musicxml',
    'unsupported.musicxml',
    'cue-notes.musicxml',
  ]

  it.each(scores)('%s: the review shows no text that bypasses the catalogs', async (name) => {
    const restore = usePseudoCatalog()
    try {
      const root = await open(name)
      const { summary } = review().result
      // Score text (titles, part names, printed tempo words) and MusicXML element names stay as written.
      const printed = summary.timingIssues.filter((t) => t.kind !== 'fermata').map((t) => t.text)
      const tokens = summary.unsupported.flatMap((u) => /\(([a-z-]+)\)$/u.exec(u.message)?.slice(1) ?? [])
      const literal = [
        summary.title,
        summary.composer ?? '',
        ...summary.parts.map((p) => p.name),
        ...printed,
        ...tokens,
      ]
      expect(untranslatedText(root, literal.filter(Boolean))).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('the score check in other languages', () => {
  /** The repeats fixture with fourteen repeated bars, one error and one importer note. */
  async function openFull(): Promise<HTMLElement> {
    await flow.openFile(file('repeats.musicxml'))
    const phase = review()
    const summary = phase.result.summary
    flow.phase.value = {
      ...phase,
      result: {
        ...phase.result,
        summary: {
          ...summary,
          repeats: {
            unfolded: true,
            repeatedBars: Array.from({ length: 14 }, (_, i) => ({ bar: String(i + 1), passes: 2 })),
            endings: ['1', '2'],
          },
          diagnostics: {
            ...summary.diagnostics,
            errors: 1,
            infos: 1,
            list: [
              ...summary.diagnostics.list,
              {
                severity: 'error',
                code: 'test-error',
                message: 'A note in bar 3 has an unreadable pitch. It was skipped.',
              },
              { severity: 'info', code: 'test-info', message: 'The performance ends at Fine in bar 8.' },
            ],
          },
        },
      },
    }
    view = mount(<ImportSheet flow={flow} pieces={[]} onClose={() => flow.close()} />)
    return view.container
  }

  it.each([
    ['ja-JP', 'ほか2件'],
    ['fr-FR', '…et 2 de plus'],
  ] as const)('%s: says how many more repeated bars there are in one phrase', async (language, more) => {
    const restore = useCatalog(language)
    try {
      const root = await openFull()
      expect($$(root, 'li').map((li) => li.textContent)).toContain(more)
    } finally {
      restore()
    }
  })

  it('shows no text that bypasses the catalogs when every check has entries', async () => {
    const restore = usePseudoCatalog()
    try {
      const root = await openFull()
      const { summary } = review().result
      const literal = [summary.title, summary.composer ?? '', ...summary.parts.map((p) => p.name)]
      expect(untranslatedText(root, literal.filter(Boolean))).toEqual([])
    } finally {
      restore()
    }
  })

  it.each([
    ['en-US', 'Tempo set', 'None found'],
    ['es-ES', 'Definido', 'Sin resultados'],
    ['fr-FR', 'Réglé', 'Aucun résultat'],
  ] as const)(
    '%s: a typed tempo reads as a state, and an empty check agrees with any noun',
    async (language, set, none) => {
      const restore = useCatalog(language)
      try {
        const root = await open('no-tempo.musicxml')
        type(byLabel(root, msg('Beats per minute')), '84')
        const tempo = $(root, '[aria-labelledby="import-tempo"]')!
        expect(tempo.querySelector('[data-tone="success"]')?.textContent).toBe(set)
        const ottavas = $$(root, 'summary').find((s) => s.textContent?.includes(msg('Ottava lines')))
        expect(ottavas?.lastElementChild?.textContent).toBe(none)
      } finally {
        restore()
      }
    },
  )
})
