/**
 * Global app state: settings, MIDI connection status and the notice queue. Signals are coarse
 * on purpose (spec "Technical design": small view state, never per-note reactive state), and
 * nothing here is touched by the MIDI input path.
 */
import { signal } from '@preact/signals'
import { DEFAULT_SETTINGS, type AppSettings, type PersistentLabelSettings } from '../core/model/settings'
import { deepEqual, mergeSettings, normalizeSettings, settingsFromStored, type SettingsPatch } from './settingsMerge'

export type { SettingsPatch } from './settingsMerge'

// ---------------------------------------------------------------------------------------------
// Settings

/** Current settings. Replace only through `updateSettings` so persistence sees every change. */
export const settings = signal<AppSettings>(DEFAULT_SETTINGS)

/**
 * Where settings are stored. Wired by the storage module; until then settings live in memory.
 * `load` returns whatever was saved (possibly partial or from an older version) or `null`.
 */
export interface SettingsPersistence {
  load(): Promise<unknown> | unknown
  save(settings: AppSettings): Promise<void> | void
}

/** True while stored settings are being read, so the UI can avoid acting on defaults. */
export const settingsLoading = signal(false)

/** Debounce for writes: dragging a slider changes settings many times per second. */
export const SETTINGS_SAVE_DEBOUNCE_MS = 400

let persistence: SettingsPersistence | null = null
/** Patches applied while the initial load is pending; replayed over the loaded settings. */
let pendingPatches: SettingsPatch<AppSettings>[] | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
let saveFailureReported = false

/**
 * Merge `patch` into the settings immutably (nested objects merge, per-clef label rules merge
 * per key, nullable fields and arrays are replaced whole). Changes are saved after a short
 * debounce; a patch that changes nothing is ignored.
 */
export function updateSettings(patch: SettingsPatch<AppSettings>): void {
  const current = settings.peek()
  const next = normalizeSettings(mergeSettings(current, patch))
  if (next === current) return
  settings.value = next
  if (pendingPatches) pendingPatches.push(patch)
  else scheduleSave()
}

function scheduleSave(): void {
  if (!persistence) return
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeSettings()
  }, SETTINGS_SAVE_DEBOUNCE_MS)
}

function writeSettings(): Promise<void> {
  const target = persistence
  if (!target) return saveChain
  const snapshot = settings.peek()
  saveChain = saveChain
    .then(() => target.save(snapshot))
    .then(() => {
      saveFailureReported = false
    })
    .catch(() => {
      if (saveFailureReported) return
      saveFailureReported = true
      pushNotice({
        kind: 'warning',
        text: 'Settings could not be saved on this device. They will reset when the page reloads.',
      })
    })
  return saveChain
}

/** Write any pending change now (call on `pagehide` / before export). Resolves when saved. */
export function flushSettings(): Promise<void> {
  if (saveTimer === null) return saveChain
  clearTimeout(saveTimer)
  saveTimer = null
  return writeSettings()
}

/**
 * Install the storage backend (or `null` for memory only) and load the saved settings over the
 * defaults. Changes made while the load is pending are replayed on top of the loaded values, so
 * nothing the user touched is lost. Resolves once settings reflect storage.
 */
export async function setSettingsPersistence(next: SettingsPersistence | null): Promise<void> {
  persistence = next
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!next) {
    pendingPatches = null
    settingsLoading.value = false
    return
  }
  settingsLoading.value = true
  const replay: SettingsPatch<AppSettings>[] = []
  pendingPatches = replay
  let stored: unknown = null
  try {
    stored = await next.load()
  } catch {
    pushNotice({ kind: 'warning', text: 'Saved settings could not be read, so defaults are in use.' })
  }
  if (persistence !== next) return
  pendingPatches = null
  settingsLoading.value = false
  let loaded = settingsFromStored(stored)
  for (const patch of replay) loaded = normalizeSettings(mergeSettings(loaded, patch))
  settings.value = loaded
  if (replay.length > 0) scheduleSave()
}

// ---------------------------------------------------------------------------------------------
// Persistent label settings and the practice-session hook

/** Called synchronously, before label settings change, with the settings about to apply. */
export type BeforeApplyLabelsHook = (next: PersistentLabelSettings) => void

const beforeApplyLabelsHooks = new Set<BeforeApplyLabelsHook>()

/**
 * Register a hook that runs before changed label settings take effect. The practice session uses
 * it to interrupt a scored attempt (spec "Persistent score labels": applying a changed mode or
 * rule during a scored attempt interrupts it before the new layout or labels appear).
 * Returns an unregister function.
 */
export function onBeforeApplyLabels(hook: BeforeApplyLabelsHook): () => void {
  beforeApplyLabelsHooks.add(hook)
  return () => {
    beforeApplyLabelsHooks.delete(hook)
  }
}

/**
 * Apply a changed label mode or rule set. The `onBeforeApplyLabels` hooks run first, then the
 * settings change. Returns false (and runs no hook) when nothing changed. Callers validate rules
 * first (`validateRule`); naming-only preferences go through `updateSettings` instead because
 * they never interrupt anything.
 */
export function applyLabelSettings(next: PersistentLabelSettings): boolean {
  if (deepEqual(next, settings.peek().labels)) return false
  for (const hook of beforeApplyLabelsHooks) {
    try {
      hook(next)
    } catch (error) {
      console.error('onBeforeApplyLabels hook failed', error)
    }
  }
  updateSettings({ labels: { mode: next.mode, rules: next.rules, tiedContinuations: next.tiedContinuations } })
  return true
}

// ---------------------------------------------------------------------------------------------
// MIDI connection status

export type ConnectionState = 'unsupported' | 'denied' | 'disconnected' | 'connecting' | 'connected'

export interface ConnectionStatus {
  readonly state: ConnectionState
  readonly inputName?: string
  readonly outputName?: string
  /** Short human explanation, e.g. why access was denied. */
  readonly detail?: string
}

/** Driven by the MIDI adapter once it is wired; the app bar chip and views read it. */
export const connectionStatus = signal<ConnectionStatus>({ state: 'disconnected' })

export function setConnectionStatus(next: ConnectionStatus): void {
  if (!deepEqual(next, connectionStatus.peek())) connectionStatus.value = next
}

// ---------------------------------------------------------------------------------------------
// Notices (toasts)

export type NoticeKind = 'info' | 'success' | 'warning' | 'error'

export interface NoticeInput {
  readonly kind: NoticeKind
  readonly text: string
  /** Auto-dismiss delay. `null` or 0 keeps it until dismissed. Defaults: 5 s, warning 8 s, error sticky. */
  readonly timeoutMs?: number | null
}

export interface AppNotice {
  readonly id: number
  readonly kind: NoticeKind
  readonly text: string
}

export const MAX_NOTICES = 4
const DEFAULT_TIMEOUT: Readonly<Record<NoticeKind, number | null>> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  error: null,
}

export const notices = signal<readonly AppNotice[]>([])

let nextNoticeId = 1
const noticeTimers = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * Show a toast and return its id. An identical message already on screen is refreshed instead of
 * stacked; at most `MAX_NOTICES` show at once (oldest dropped).
 */
export function pushNotice(input: NoticeInput): number {
  const existing = notices.peek().find((n) => n.kind === input.kind && n.text === input.text)
  const id = existing?.id ?? nextNoticeId++
  if (!existing) {
    const list = [...notices.peek(), { id, kind: input.kind, text: input.text }]
    const dropped = list.splice(0, Math.max(0, list.length - MAX_NOTICES))
    for (const old of dropped) clearNoticeTimer(old.id)
    notices.value = list
  }
  clearNoticeTimer(id)
  const timeout = input.timeoutMs === undefined ? DEFAULT_TIMEOUT[input.kind] : input.timeoutMs
  if (timeout)
    noticeTimers.set(
      id,
      setTimeout(() => dismissNotice(id), timeout),
    )
  return id
}

export function dismissNotice(id: number): void {
  clearNoticeTimer(id)
  if (notices.peek().some((n) => n.id === id)) notices.value = notices.peek().filter((n) => n.id !== id)
}

function clearNoticeTimer(id: number): void {
  const timer = noticeTimers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  noticeTimers.delete(id)
}

// ---------------------------------------------------------------------------------------------

/** Restore every signal, hook and timer to its initial state. Tests only. */
export function resetAppStateForTests(): void {
  persistence = null
  pendingPatches = null
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  saveChain = Promise.resolve()
  saveFailureReported = false
  beforeApplyLabelsHooks.clear()
  for (const id of [...noticeTimers.keys()]) clearNoticeTimer(id)
  settings.value = DEFAULT_SETTINGS
  settingsLoading.value = false
  connectionStatus.value = { state: 'disconnected' }
  notices.value = []
}
