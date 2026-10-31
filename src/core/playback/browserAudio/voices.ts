/**
 * Voices for browser sound: the nearest Salamander sample repitched with playbackRate, or a
 * small oscillator synth while samples load or when they failed (DECISIONS S1). A `VoiceBank`
 * applies piano-like key and pedal semantics in context time: overlapping same-pitch notes
 * are counted so an older release never cuts a newer note, sustain and sostenuto hold
 * released keys, the soft pedal lowers new attacks, and a re-strike damps the previous voice.
 * Calls must arrive in time order (the transport hands browser events out in order).
 */
import type { SampleBank } from './samples'

export interface Voice {
  /** Context time the voice starts. */
  readonly start: number
  /** Release with a damper decay (fast = re-strike or cleanup). */
  release(when: number, fast: boolean): void
  /** Silence immediately (cleanup of voices that have not started yet, or panic). */
  kill(): void
}

export type VoiceFactory = (note: number, velocity: number, when: number) => Voice

/** Perceived loudness curve for velocity 1..127. */
export function velocityGain(velocity: number): number {
  const v = Math.max(0, Math.min(127, velocity)) / 127
  return Math.pow(v, 1.6)
}

function safeStop(node: AudioScheduledSourceNode, when?: number): void {
  try {
    node.stop(when)
  } catch {
    // already stopped
  }
}

function releaseGain(param: AudioParam, when: number, fast: boolean): void {
  const withHold = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
  if (typeof withHold.cancelAndHoldAtTime === 'function') withHold.cancelAndHoldAtTime(when)
  else param.cancelScheduledValues(when)
  param.setTargetAtTime(0, when, fast ? 0.015 : 0.1)
}

/** Voice factory using the sample bank with a synth fallback. */
export function sampleVoices(ctx: BaseAudioContext, bank: SampleBank, out: AudioNode): VoiceFactory {
  const synth = synthVoices(ctx, out)
  return (note, velocity, when) => {
    const sample = bank.nearest(note)
    if (!sample) return synth(note, velocity, when)
    const src = ctx.createBufferSource()
    src.buffer = sample.buffer
    src.playbackRate.value = Math.pow(2, (note - sample.midi) / 12)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(velocityGain(velocity), when)
    src.connect(gain)
    gain.connect(out)
    src.start(when)
    src.onended = () => gain.disconnect()
    return {
      start: when,
      release(at, fast) {
        releaseGain(gain.gain, Math.max(at, when), fast)
        safeStop(src, Math.max(at, when) + (fast ? 0.1 : 0.8))
      },
      kill() {
        gain.disconnect()
        safeStop(src)
      },
    }
  }
}

/** Small triangle-wave synth with a piano-like decay (fallback). */
export function synthVoices(ctx: BaseAudioContext, out: AudioNode): VoiceFactory {
  return (note, velocity, when) => {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12)
    const gain = ctx.createGain()
    const peak = 0.35 * velocityGain(velocity)
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(peak, when + 0.005)
    gain.gain.setTargetAtTime(peak * 0.15, when + 0.005, 0.6)
    osc.connect(gain)
    gain.connect(out)
    osc.start(when)
    osc.stop(when + 8)
    osc.onended = () => gain.disconnect()
    return {
      start: when,
      release(at, fast) {
        releaseGain(gain.gain, Math.max(at, when), fast)
        safeStop(osc, Math.max(at, when) + (fast ? 0.1 : 0.5))
      },
      kill() {
        gain.disconnect()
        safeStop(osc)
      },
    }
  }
}

const SUSTAIN = 64
const SOSTENUTO = 66
const SOFT = 67
const SOFT_FACTOR = 0.7

/** Key, overlap and pedal state for one sound source (app playback or monitored input). */
export class VoiceBank {
  private readonly keyed = new Uint16Array(128)
  private readonly current: Array<Voice | undefined> = new Array<Voice | undefined>(128)
  private readonly pedalHeld = new Uint8Array(128)
  private readonly sostenutoHeld = new Uint8Array(128)
  private live = new Set<Voice>()
  private sustain = false
  private sostenuto = false
  private soft = false

  constructor(private readonly factory: VoiceFactory) {}

  noteOn(note: number, velocity: number, when: number): void {
    const prev = this.current[note]
    if (prev) {
      prev.release(when, true)
      this.live.delete(prev)
    }
    const v = this.factory(note, this.soft ? velocity * SOFT_FACTOR : velocity, when)
    this.current[note] = v
    this.live.add(v)
    this.keyed[note]!++
    this.pedalHeld[note] = 0
  }

  noteOff(note: number, when: number): void {
    if (this.keyed[note] === 0) return
    this.keyed[note]!--
    if (this.keyed[note]! > 0) return
    if (this.sustain || this.sostenutoHeld[note]) {
      this.pedalHeld[note] = 1
      return
    }
    this.release(note, when)
  }

  control(controller: number, value: number, when: number): void {
    const down = value >= 64
    if (controller === SUSTAIN) {
      if (this.sustain && !down) {
        for (let n = 0; n < 128; n++) {
          if (this.pedalHeld[n] && !this.sostenutoHeld[n] && this.keyed[n] === 0) this.release(n, when)
        }
      }
      this.sustain = down
    } else if (controller === SOSTENUTO) {
      if (!this.sostenuto && down) {
        for (let n = 0; n < 128; n++) if (this.keyed[n]! > 0) this.sostenutoHeld[n] = 1
      } else if (this.sostenuto && !down) {
        for (let n = 0; n < 128; n++) {
          if (!this.sostenutoHeld[n]) continue
          this.sostenutoHeld[n] = 0
          if (this.keyed[n] === 0 && this.pedalHeld[n] && !this.sustain) this.release(n, when)
        }
      }
      this.sostenuto = down
    } else if (controller === SOFT) {
      this.soft = down
    }
  }

  /**
   * Silence everything: voices not yet started are killed, sounding ones fade quickly.
   * Resets key and pedal state.
   */
  silence(now: number): void {
    for (const v of this.live) {
      if (v.start > now) v.kill()
      else v.release(now, true)
    }
    this.live = new Set()
    this.current.fill(undefined)
    this.keyed.fill(0)
    this.pedalHeld.fill(0)
    this.sostenutoHeld.fill(0)
    this.sustain = false
    this.sostenuto = false
    this.soft = false
  }

  /** Voices created and not yet silenced (for tests and leak checks). */
  get liveCount(): number {
    return this.live.size
  }

  private release(note: number, when: number): void {
    this.pedalHeld[note] = 0
    const v = this.current[note]
    if (!v) return
    v.release(when, false)
    this.current[note] = undefined
    this.live.delete(v)
  }
}
