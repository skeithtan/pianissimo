/**
 * What the Library needs from the outside world, injectable for tests. Production values come
 * from `app/services` (storage), the import worker client and the browser.
 */
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import { connectSettingsStorage, getStorage } from '../../app/services'
import { flushSettings } from '../../app/state'
import { createImportClient, type ImportClient } from '../../core/import/client'
import type { StorageManagerLike } from '../../core/storage/persist'
import type { PianissimoStorage } from '../../core/storage/storage'

export interface LibraryDeps {
  getStorage(): Promise<PianissimoStorage>
  /** A fresh import client per import flow (disposed when the flow closes). */
  createImportClient(): ImportClient
  /** `navigator.storage` stand-in; undefined uses the browser's. */
  readonly storageManager?: StorageManagerLike | undefined
  now(): number
  /** Save bytes as a file the user keeps (the backup). */
  download(bytes: Uint8Array, fileName: string): void
  /** Write pending settings now (before a restore replaces them). */
  flushSettings(): Promise<void>
  /** Reload settings from storage into the app (after a restore). */
  reloadSettings(): Promise<unknown>
  /**
   * iPadOS/iOS file pickers gray out files whose extension has no registered type, so the
   * picker there accepts any file and the importer sniffs the content (DECISIONS L3).
   */
  isAppleMobile(): boolean
}

function browserDownload(bytes: Uint8Array, fileName: string): void {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari needs the URL alive until the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function detectAppleMobile(
  nav: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined = globalThis.navigator,
): boolean {
  if (!nav) return false
  if (/iPad|iPhone|iPod/.test(nav.userAgent ?? '')) return true
  // iPadOS 13+ reports a Mac platform; touch points tell it apart from a real Mac.
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1
}

export const defaultLibraryDeps: LibraryDeps = {
  getStorage,
  createImportClient: () => createImportClient(),
  now: () => Date.now(),
  download: browserDownload,
  flushSettings,
  reloadSettings: connectSettingsStorage,
  isAppleMobile: () => detectAppleMobile(),
}

export const LibraryDepsContext = createContext<LibraryDeps>(defaultLibraryDeps)

export function useLibraryDeps(): LibraryDeps {
  return useContext(LibraryDepsContext)
}
