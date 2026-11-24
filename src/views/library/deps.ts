/**
 * What the Library needs from the outside world, injectable for tests. Production values come
 * from `app/services` (storage), the import worker client and the browser.
 */
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import { detectAppleMobile } from '../../app/pianoBrowsers'
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
  /** Save a file the user keeps (the backup). */
  download(file: Blob, fileName: string): void
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

/** Hand the Blob itself to the browser: no copy of a backup that may hold recordings. */
function browserDownload(file: Blob, fileName: string): void {
  const url = URL.createObjectURL(file)
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
