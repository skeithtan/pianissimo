/**
 * App services: lazily created singletons shared by every view and the practice session.
 *
 * - `getStorage()`: the IndexedDB storage (opened on first use, history lifecycle attached once).
 * - `getMidiService()` / `getMidi()`: the one MIDI adapter and its connection state. Creating
 *   it never asks for MIDI access (spec "Delivery and device compatibility": request through the
 *   browser's permission flow on an explicit action).
 * - `startServices()`: boot wiring — settings persistence (memory fallback when IndexedDB is
 *   unavailable) and silent reconnection of a remembered route when permission is already granted.
 *
 * Framework-free: the practice session subscribes with `getMidiService().onRoute(...)` and
 * registers its Stop sound with `registerSoundOwner`. The shell's `connectionStatus` signal
 * follows the service's snapshots.
 */
import { MidiAdapter } from '../core/midi/adapter'
import type { MidiNavigatorLike } from '../core/midi/webmidi'
import type { MidiRouteSettings } from '../core/model/settings'
import {
  isQuotaError,
  openStorage,
  type HistoryWriterOptions,
  type PianissimoStorage,
  type StorageOptions,
} from '../core/storage'
import { getFeatures } from './features'
import { MidiService } from './services/midiService'
import {
  dismissNotice,
  pushNotice,
  type NoticeInput,
  setConnectionStatus,
  setSettingsPersistence,
  settings,
  updateSettings,
} from './state'
import { APP_VERSION } from './version'

export { MidiService, ROUTE_NOTICE_COALESCE_MS, connectionStatusFor, hasRememberedRoute } from './services/midiService'
export type { MidiSnapshot, SelectedPort, SoundOwner, StopSoundResult } from './services/midiService'

/** Injectable environment (tests). */
export interface ServicesEnv {
  readonly navigator?: MidiNavigatorLike | undefined
  readonly openStorage?: (options: StorageOptions) => Promise<PianissimoStorage>
  readonly now?: () => number
}

let env: ServicesEnv = {}
let storagePromise: Promise<PianissimoStorage> | null = null
let midiService: MidiService | null = null

export const STORAGE_UNAVAILABLE_NOTICE =
  'Saving is unavailable in this browser window (a private window often blocks it). ' +
  'Settings work until the page is closed; open Pianissimo in a normal window to keep them.'

export const HISTORY_QUOTA_NOTICE =
  'Practice results could not be saved because this browser’s storage is full. ' +
  'Export a backup and delete pieces you no longer need.'
export const HISTORY_SAVE_FAILED_NOTICE =
  'Practice results could not be saved. Recent attempts may be missing from results and suggestions.'

/**
 * History-writer hooks that tell the player when practice records are lost: the writer drops a
 * batch after `MAX_FLUSH_FAILURES` failed flushes (and a malformed record alone) and reports it
 * through `onError` with the number of dropped items. One warning per failure streak; the next
 * successful write ends the streak. Retries that lose nothing stay silent.
 */
export function historyFailureNotices(
  push: (notice: NoticeInput) => unknown = pushNotice,
): Required<Pick<HistoryWriterOptions, 'onError' | 'onFlush'>> {
  let notified = false
  return {
    onError: (error, dropped) => {
      if (dropped <= 0 || notified) return
      notified = true
      push({
        kind: 'warning',
        text: isQuotaError(error) ? HISTORY_QUOTA_NOTICE : HISTORY_SAVE_FAILED_NOTICE,
        timeoutMs: null,
      })
    },
    onFlush: () => {
      notified = false
    },
  }
}

/**
 * The app's storage, opened once. The practice-history writer flushes on `pagehide` and when
 * the page is hidden, and lost practice records raise a warning notice. A failed open is not
 * cached, so a later call retries.
 */
export function getStorage(): Promise<PianissimoStorage> {
  if (!storagePromise) {
    const options: StorageOptions = { appVersion: APP_VERSION, history: historyFailureNotices() }
    const open = env.openStorage ?? ((o: StorageOptions) => openStorage(undefined, o))
    const pending = open(options).then((storage) => {
      storage.history.attachLifecycle()
      return storage
    })
    storagePromise = pending
    pending.catch(() => {
      if (storagePromise === pending) storagePromise = null
    })
  }
  return storagePromise
}

/** The MIDI connection owner, created on first use (without requesting access). */
export function getMidiService(): MidiService {
  midiService ??= new MidiService({
    createAdapter: () =>
      new MidiAdapter({
        ...('navigator' in env ? { navigator: env.navigator } : {}),
        ...(env.now ? { now: env.now } : {}),
      }),
    getRoute: () => settings.peek().route,
    setRoute: (route: MidiRouteSettings) => updateSettings({ route }),
    setStatus: setConnectionStatus,
    notify: pushNotice,
    dismiss: dismissNotice,
    unsupportedDetail: getFeatures().features.webMidi.explanation,
    ...(env.now ? { now: env.now } : {}),
  })
  return midiService
}

/** The app's `MidiAdapter`, created on first use. Never requests access by itself. */
export function getMidi(): MidiAdapter {
  return getMidiService().adapter
}

/**
 * Plug storage into settings. When IndexedDB cannot be opened, settings stay in memory and one
 * warning notice explains it. Resolves true when settings are persisted.
 */
export async function connectSettingsStorage(): Promise<boolean> {
  let storage: PianissimoStorage
  try {
    storage = await getStorage()
  } catch {
    await setSettingsPersistence(null)
    pushNotice({ kind: 'warning', text: STORAGE_UNAVAILABLE_NOTICE, timeoutMs: null })
    return false
  }
  await setSettingsPersistence({
    load: () => storage.loadSettings(),
    save: async (next) => {
      await storage.saveSettings(next)
    },
  })
  return true
}

/**
 * Boot wiring after the shell renders: load settings from storage, then ask for MIDI access and
 * connect the piano (the remembered route, or the only one present) without waiting for the
 * Connection setup (user, 2026-10-31).
 */
export async function startServices(): Promise<void> {
  await connectSettingsStorage()
  try {
    await getMidiService().connectOnBoot()
  } catch (error) {
    console.error('MIDI connection at boot failed', error)
  }
}

/** Replace the environment and forget every singleton. Tests only. */
export function resetServicesForTests(next: ServicesEnv = {}): void {
  midiService?.dispose()
  midiService = null
  storagePromise = null
  env = next
}
