// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'preact/test-utils'
import { notices, resetAppStateForTests } from '../../app/state'
import { importPiece, openFresh } from '../../core/storage/testkit'
import { LibraryDepsContext } from '../library/deps'
import { bytesFile, testDeps, tick, type TestDeps } from '../library/testkit'
import { $$, click, mount, type Mounted } from '../shared/testing'
import { BackupSection } from './BackupSection'

let view: Mounted | null = null
let deps: TestDeps

const settle = (ms = 20) =>
  act(async () => {
    await tick(ms)
  })

async function until(check: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await settle(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeEach(async () => {
  resetAppStateForTests()
  deps = await testDeps()
})
afterEach(() => {
  view?.unmount()
  view = null
  resetAppStateForTests()
})

async function open(): Promise<HTMLElement> {
  view = mount(
    <LibraryDepsContext.Provider value={deps}>
      <BackupSection />
    </LibraryDepsContext.Provider>,
  )
  await settle()
  return view.container
}

function pick(label: HTMLElement | null, file: File): void {
  const input = label?.querySelector('input[type="file"]') as HTMLInputElement | null
  if (!input) throw new Error('no file input')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const fileButton = (root: HTMLElement, text: string) =>
  $$(root, 'label').find((l) => l.textContent?.trim() === text) ?? null
const button = (root: HTMLElement, text: string) =>
  $$(root, 'button').find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined

describe('Settings → Backup', () => {
  it('exports a .pianissimo.zip download', async () => {
    await importPiece(deps.storage, 'v1')
    const root = await open()
    click(button(root, 'Export backup'))
    await until(() => deps.downloads.length === 1, 'download')
    expect(deps.downloads[0]!.fileName).toMatch(/^pianissimo-2026-10-29\.pianissimo\.zip$/)
    expect(deps.downloads[0]!.bytes.byteLength).toBeGreaterThan(100)
    expect(notices.value.some((n) => /Backup saved/.test(n.text))).toBe(true)
  })

  it('restores a backup after confirmation, in place, and reports what was merged', async () => {
    const other = await openFresh()
    await importPiece(other, 'v9', { title: 'From the iPad' })
    const backup = await other.exportAll()
    const root = await open()
    expect(root.textContent).toMatch(/nothing here is deleted/)
    pick(fileButton(root, 'Restore from backup…'), bytesFile('library.pianissimo.zip', backup))
    await settle()
    expect(root.textContent).toContain('library.pianissimo.zip')
    expect($$(root, 'dialog')).toHaveLength(0)
    click(button(root, 'Restore'))
    await until(() => /Backup restored/.test(root.textContent ?? ''), 'restored')
    expect(root.textContent).toContain('Pieces: 1 added')
    expect(deps.flushes).toBe(1)
    expect(deps.reloads).toBe(1)
    expect((await deps.storage.listPieces()).map((p) => p.title)).toEqual(['From the iPad'])
    click(button(root, 'Done'))
    await settle()
    expect(fileButton(root, 'Restore from backup…')).not.toBeNull()
  })

  it('shows why a file is not a backup, and changes nothing', async () => {
    const root = await open()
    pick(fileButton(root, 'Restore from backup…'), bytesFile('notes.zip', new TextEncoder().encode('hello')))
    await settle()
    click(button(root, 'Restore'))
    await until(() => /could not be restored/.test(root.textContent ?? ''), 'error')
    expect(await deps.storage.listPieces()).toEqual([])
    expect(deps.reloads).toBe(0)
  })
})
