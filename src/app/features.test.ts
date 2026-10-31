import { describe, expect, it } from 'vitest'
import { detectFeatures, type FeatureEnvironment } from './features'

/** A Worker constructor that reads the `type` option like a module-worker-capable engine. */
class ModuleCapableWorker {
  constructor(_url: string, options?: { type?: string }) {
    void options?.type
  }
  terminate(): void {}
}

/** An engine that predates module workers: it never reads `type`. */
class ClassicOnlyWorker {
  constructor(_url: string, _options?: object) {}
  terminate(): void {}
}

const FULL: FeatureEnvironment = {
  navigator: {
    requestMIDIAccess: () => Promise.resolve({}),
    wakeLock: { request: () => Promise.resolve({}) },
    storage: { persist: () => Promise.resolve(true) },
  },
  AudioContext: class {},
  Worker: ModuleCapableWorker,
  indexedDB: {},
}

describe('detectFeatures', () => {
  it('reports everything supported in a capable browser', () => {
    const report = detectFeatures(FULL)
    expect(report.missing).toEqual([])
    for (const feature of Object.values(report.features)) {
      expect(feature.supported).toBe(true)
      expect(feature.explanation).toBeNull()
    }
  })

  it('explains missing Web MIDI as a Safari limitation with the workaround', () => {
    const report = detectFeatures({ ...FULL, navigator: { ...FULL.navigator, requestMIDIAccess: undefined } })
    const midi = report.features.webMidi
    expect(midi.supported).toBe(false)
    expect(midi.explanation).toMatch(/Safari/u)
    expect(midi.explanation).toMatch(/MIDIWeb/u)
    expect(midi.explanation).toMatch(/Chrome/u)
    expect(midi.explanation).toMatch(/view scores/u)
    expect(midi.severity).toBe('important')
    expect(report.features.webAudio.supported).toBe(true)
  })

  it('accepts the prefixed AudioContext', () => {
    const { AudioContext: _omit, ...rest } = FULL
    void _omit
    expect(detectFeatures({ ...rest, webkitAudioContext: class {} }).features.webAudio.supported).toBe(true)
    const none = detectFeatures(rest)
    expect(none.features.webAudio.supported).toBe(false)
    expect(none.features.webAudio.explanation).toMatch(/metronome/u)
  })

  it('detects module worker support by whether the engine reads the type option', () => {
    expect(detectFeatures({ ...FULL, Worker: ModuleCapableWorker }).features.moduleWorkers.supported).toBe(true)
    const classic = detectFeatures({ ...FULL, Worker: ClassicOnlyWorker }).features.moduleWorkers
    expect(classic.supported).toBe(false)
    expect(classic.severity).toBe('required')
    expect(classic.explanation).toMatch(/import/u)
    expect(detectFeatures({ ...FULL, Worker: undefined }).features.moduleWorkers.supported).toBe(false)
  })

  it('still reads the type option when the worker cannot start', () => {
    class Refusing {
      constructor(_url: string, options?: { type?: string }) {
        void options?.type
        throw new DOMException('blocked', 'SecurityError')
      }
    }
    expect(detectFeatures({ ...FULL, Worker: Refusing }).features.moduleWorkers.supported).toBe(true)
  })

  it('terminates the probe worker', () => {
    let terminated = false
    class Probe {
      constructor(_url: string, options?: { type?: string }) {
        void options?.type
      }
      terminate(): void {
        terminated = true
      }
    }
    detectFeatures({ ...FULL, Worker: Probe })
    expect(terminated).toBe(true)
  })

  it('treats absent or null IndexedDB as missing storage', () => {
    expect(detectFeatures({ ...FULL, indexedDB: undefined }).features.indexedDb.supported).toBe(false)
    expect(detectFeatures({ ...FULL, indexedDB: null }).features.indexedDb.supported).toBe(false)
    expect(detectFeatures({ ...FULL, indexedDB: undefined }).features.indexedDb.explanation).toMatch(/private window/u)
  })

  it('detects persistent storage and wake lock independently and marks them optional', () => {
    const report = detectFeatures({ ...FULL, navigator: { requestMIDIAccess: () => undefined } })
    expect(report.features.persistentStorage.supported).toBe(false)
    expect(report.features.persistentStorage.explanation).toMatch(/Export a backup/u)
    expect(report.features.wakeLock.supported).toBe(false)
    expect(report.features.wakeLock.explanation).toMatch(/auto-lock/u)
    expect(report.features.persistentStorage.severity).toBe('optional')
    expect(report.features.wakeLock.severity).toBe('optional')
  })

  it('lists missing features most severe first', () => {
    const report = detectFeatures({})
    expect(report.missing).toHaveLength(6)
    const severities = report.missing.map((f) => f.severity)
    expect(severities).toEqual(
      [...severities].sort(
        (a, b) => ['required', 'important', 'optional'].indexOf(a) - ['required', 'important', 'optional'].indexOf(b),
      ),
    )
    expect(report.missing[0]?.severity).toBe('required')
    expect(report.missing.at(-1)?.severity).toBe('optional')
  })

  it('never throws when a global is a throwing getter', () => {
    const hostile = {
      get indexedDB(): unknown {
        throw new Error('SecurityError')
      },
    } as FeatureEnvironment
    expect(detectFeatures(hostile).features.indexedDb.supported).toBe(false)
  })

  it('gives every missing feature a short human explanation', () => {
    for (const feature of detectFeatures({}).missing) {
      expect(feature.explanation?.length ?? 0).toBeGreaterThan(30)
      expect(feature.explanation?.length ?? 0).toBeLessThan(300)
    }
  })
})
