import type { RecordingSettings } from '../model/settings'

/** An audio input as the browser describes it: an opened track's settings, or a listed device. */
export interface AudioInputIdentity {
  readonly deviceId: string
  /** The browser's own name for it, '' when it gives none. */
  readonly label: string
}

export const NO_RECORDING_INPUT: RecordingSettings = { inputId: null, inputLabel: null }

/** IDs that mean "whatever the system uses now" (Chrome): they never say which device that is. */
const SYSTEM_CHOICES: ReadonlySet<string> = new Set(['default', 'communications'])

/** What to remember of an input (DECISIONS D20): nothing that could not recognize it again. */
export function rememberInput({ deviceId, label }: AudioInputIdentity): RecordingSettings {
  const inputLabel = label.trim() || null
  const inputId = deviceId && (inputLabel !== null || !SYSTEM_CHOICES.has(deviceId)) ? deviceId : null
  return { inputId, inputLabel }
}

export function hasRememberedInput(saved: RecordingSettings): boolean {
  return saved.inputId !== null || saved.inputLabel !== null
}

/**
 * Is this the remembered input: the same device ID or, when the browser has given out new IDs, the
 * same name. An ID that stands for the system's choice counts only with the same name.
 */
export function isRememberedInput(saved: RecordingSettings, input: AudioInputIdentity): boolean {
  if (saved.inputId !== null && saved.inputId === input.deviceId && !SYSTEM_CHOICES.has(saved.inputId)) return true
  return saved.inputLabel !== null && saved.inputLabel === input.label.trim()
}
