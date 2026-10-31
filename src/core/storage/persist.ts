/**
 * Feature-detected wrappers around `navigator.storage` (spec "Storage and recovery": recover
 * from memory pressure; browser storage is not the only copy). Browsers may evict storage that
 * is not persistent, so the app asks for persistence after a successful import. Every call
 * degrades to "unsupported" instead of throwing.
 */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

export type PersistOutcome = 'granted' | 'denied' | 'unsupported'

export interface StorageEstimate {
  readonly usageBytes: number | undefined
  readonly quotaBytes: number | undefined
  /** usage / quota in 0..1 when both are known and the quota is positive. */
  readonly fraction: number | undefined
}

function defaultManager(): StorageManagerLike | undefined {
  const nav = (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator
  return nav?.storage
}

/** Ask the browser to keep this origin's storage. Safe to call repeatedly. */
export async function requestPersistentStorage(
  manager: StorageManagerLike | undefined = defaultManager(),
): Promise<PersistOutcome> {
  if (!manager || typeof manager.persist !== 'function') return 'unsupported'
  try {
    if (typeof manager.persisted === 'function' && (await manager.persisted())) return 'granted'
    return (await manager.persist()) ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/** Whether storage is already persistent; undefined when the browser cannot say. */
export async function isStoragePersistent(
  manager: StorageManagerLike | undefined = defaultManager(),
): Promise<boolean | undefined> {
  if (!manager || typeof manager.persisted !== 'function') return undefined
  try {
    return await manager.persisted()
  } catch {
    return undefined
  }
}

/** Usage and quota, or undefined when the browser has no estimate. */
export async function estimateStorage(
  manager: StorageManagerLike | undefined = defaultManager(),
): Promise<StorageEstimate | undefined> {
  if (!manager || typeof manager.estimate !== 'function') return undefined
  try {
    const { usage, quota } = await manager.estimate()
    const fraction = usage !== undefined && quota !== undefined && quota > 0 ? Math.min(1, usage / quota) : undefined
    return { usageBytes: usage, quotaBytes: quota, fraction }
  } catch {
    return undefined
  }
}

/** Whether this browser exposes IndexedDB at all (it may still refuse to open, e.g. in some private modes). */
export function isIndexedDbAvailable(): boolean {
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
}

/** True for the browser's "storage is full" failures, so the UI can say so and suggest an export. */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { name?: unknown; code?: unknown }
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22
}
