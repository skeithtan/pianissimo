/**
 * Browser capability detection (spec "Technical design": feature-detect MIDI, audio, workers,
 * storage and optional wake prevention; "Delivery and device compatibility": Safari has no Web
 * MIDI, so it can still offer score viewing and reference playback). Pure over an injectable
 * global-like object so every combination is testable.
 */

export type FeatureId = 'webMidi' | 'webAudio' | 'moduleWorkers' | 'indexedDb' | 'persistentStorage' | 'wakeLock'

/**
 * How much a missing feature matters.
 * - `required`: part of the app cannot work at all (import, saving).
 * - `important`: a headline capability is missing but the rest of the app is usable.
 * - `optional`: a convenience; the app works as designed without it.
 */
export type FeatureSeverity = 'required' | 'important' | 'optional'

export interface FeatureStatus {
  readonly id: FeatureId
  readonly label: string
  readonly supported: boolean
  readonly severity: FeatureSeverity
  /** What the learner loses and what to do instead; null when supported. */
  readonly explanation: string | null
}

export interface FeatureReport {
  readonly features: Readonly<Record<FeatureId, FeatureStatus>>
  /** Unsupported features, most severe first. */
  readonly missing: readonly FeatureStatus[]
}

/** The slice of `globalThis` the detector reads. Anything may be absent. */
export interface FeatureEnvironment {
  readonly navigator?: {
    readonly requestMIDIAccess?: unknown
    readonly wakeLock?: unknown
    readonly storage?: { readonly persist?: unknown } | undefined
  }
  readonly AudioContext?: unknown
  readonly webkitAudioContext?: unknown
  readonly Worker?: unknown
  readonly indexedDB?: unknown
}

const DEFINITIONS: Readonly<Record<FeatureId, { label: string; severity: FeatureSeverity; explanation: string }>> = {
  webMidi: {
    label: 'Web MIDI',
    severity: 'important',
    explanation:
      'This browser has no Web MIDI (Safari does not offer it), so a piano cannot be connected for live practice. ' +
      'You can still view scores and use browser-sound reference playback. ' +
      'Use the MIDIWeb browser on an iPad, or Chrome on a computer.',
  },
  webAudio: {
    label: 'Web Audio',
    severity: 'important',
    explanation:
      'This browser cannot play sound itself, so browser sound and the metronome click are unavailable. ' +
      'Playing through a connected piano still works.',
  },
  moduleWorkers: {
    label: 'Background workers',
    severity: 'required',
    explanation:
      'This browser cannot run the background worker that reads MusicXML files, so scores cannot be imported. ' +
      'Update the browser, or use a recent Chrome or Safari.',
  },
  indexedDb: {
    label: 'Local storage',
    severity: 'required',
    explanation:
      'This browser blocks local storage (a private window often does), so scores, settings and practice history cannot be saved. ' +
      'Open Pianissimo in a normal window.',
  },
  persistentStorage: {
    label: 'Persistent storage',
    severity: 'optional',
    explanation:
      'This browser may clear saved scores when device space runs low. Export a backup from the Library now and then.',
  },
  wakeLock: {
    label: 'Keep screen awake',
    severity: 'optional',
    explanation:
      'This browser cannot keep the screen awake, so it may dim or lock while you play. Raise the device auto-lock time while practicing.',
  },
}

const SEVERITY_ORDER: Readonly<Record<FeatureSeverity, number>> = { required: 0, important: 1, optional: 2 }

/**
 * Module workers are the one feature with no property to test, so a throwaway worker is
 * constructed with an options object whose `type` getter records whether the engine reads it.
 * WebIDL converts the options before the constructor can fail on the URL, so the probe is
 * accurate even when the worker itself cannot start.
 */
function supportsModuleWorkers(Ctor: unknown): boolean {
  if (typeof Ctor !== 'function') return false
  let read = false
  const options = {
    get type() {
      read = true
      return 'module' as const
    },
  }
  try {
    const worker = new (Ctor as new (url: string, options: object) => { terminate(): void })(
      'data:text/javascript,',
      options,
    )
    worker.terminate()
  } catch {
    // Construction can fail for reasons unrelated to module support; only `read` matters.
  }
  return read
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function'
}

/** Property getters can throw in sandboxed frames; an unreadable feature counts as missing. */
function probe(test: () => boolean): boolean {
  try {
    return test()
  } catch {
    return false
  }
}

function build(id: FeatureId, supported: boolean): FeatureStatus {
  const def = DEFINITIONS[id]
  return { id, label: def.label, severity: def.severity, supported, explanation: supported ? null : def.explanation }
}

/** Detect every capability the app uses. Cheap; call once at startup (see `getFeatures`). */
export function detectFeatures(env: FeatureEnvironment = globalThis as FeatureEnvironment): FeatureReport {
  const features: Record<FeatureId, FeatureStatus> = {
    webMidi: build(
      'webMidi',
      probe(() => isFunction(env.navigator?.requestMIDIAccess)),
    ),
    webAudio: build(
      'webAudio',
      probe(() => isFunction(env.AudioContext) || isFunction(env.webkitAudioContext)),
    ),
    moduleWorkers: build(
      'moduleWorkers',
      probe(() => supportsModuleWorkers(env.Worker)),
    ),
    indexedDb: build(
      'indexedDb',
      probe(() => env.indexedDB !== undefined && env.indexedDB !== null),
    ),
    persistentStorage: build(
      'persistentStorage',
      probe(() => isFunction(env.navigator?.storage?.persist)),
    ),
    wakeLock: build(
      'wakeLock',
      probe(() => env.navigator?.wakeLock !== undefined && env.navigator.wakeLock !== null),
    ),
  }
  const missing = Object.values(features)
    .filter((f) => !f.supported)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return { features, missing }
}

let cached: FeatureReport | null = null

/** Detection for the running browser, computed once. */
export function getFeatures(): FeatureReport {
  cached ??= detectFeatures()
  return cached
}

/** Forget the cached report. Tests only. */
export function resetFeaturesForTests(): void {
  cached = null
}
