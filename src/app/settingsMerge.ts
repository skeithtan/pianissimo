/**
 * Pure helpers behind `updateSettings`: immutable deep merge, structural equality and
 * normalization of settings that came from outside the app (storage, restore).
 */
import { DEFAULT_SETTINGS, type AppSettings } from '../core/model/settings'
import { normalizeSettings as normalizeStoredSettings } from '../core/storage/settings'

/**
 * Deeply optional view of a settings shape. Nullable fields (`threshold`, `hintPedal`, route
 * ids) are atomic: a patch replaces them whole, so a partial `Spelling` can never be merged
 * into `null`. Arrays are atomic too. Records such as `labels.rules` merge per key.
 */
export type SettingsPatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: null extends T[K] ? T[K] : SettingsPatch<T[K]> }
    : T

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Immutable deep merge. Plain objects merge key by key; everything else in `patch` replaces the
 * base. Untouched branches keep their identity and a patch that changes nothing returns `base`
 * itself, so signals only notify on real changes. Prototype-polluting keys are ignored because
 * persisted data and restored backups are untrusted input.
 */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch as T
  let out: Record<string, unknown> | null = null
  for (const key of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(key)) continue
    const next = patch[key]
    if (next === undefined) continue
    const merged = mergeSettings(base[key], next)
    if (merged !== base[key]) {
      out ??= { ...base }
      out[key] = merged
    }
  }
  return (out ?? base) as T
}

/** Structural equality for JSON-like data (settings, rules). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]))
}

/**
 * Repair settings after a patch: every field is validated by the one storage normalizer
 * (`core/storage/settings.ts`), which falls back per field to `DEFAULT_SETTINGS`. Returns
 * `settings` itself when nothing needed repair, so signals only notify on real changes.
 */
export function normalizeSettings(settings: AppSettings): AppSettings {
  const repaired = normalizeStoredSettings(settings)
  return deepEqual(repaired, settings) ? settings : repaired
}

/**
 * Settings read back from storage or a backup: unknown, possibly partial or from another version.
 * Returns `DEFAULT_SETTINGS` itself when the stored value adds nothing to the defaults.
 */
export function settingsFromStored(stored: unknown): AppSettings {
  const loaded = normalizeStoredSettings(stored)
  return deepEqual(loaded, DEFAULT_SETTINGS) ? DEFAULT_SETTINGS : loaded
}
