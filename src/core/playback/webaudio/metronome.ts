/**
 * Web Audio metronome click (spec "Recommended defaults": metronome off; an optional audible
 * reference without forcing advancement). Scheduled by the musical transport like any other
 * event, and usable alongside MIDI output: the click always sounds in the browser so it never
 * mixes into the piano's channel. Short synthesized blips, no samples. Load this module
 * (dynamic import) and create the sink only when the metronome is enabled.
 */
import type { Clock, MetronomeSink } from '../types'
import { contextTimeFor } from './context'

export interface WebAudioMetronomeOptions {
  readonly context: BaseAudioContext
  readonly clock: Clock
  /** 0..1. */
  readonly volume?: number
}

interface Scheduled {
  readonly src: OscillatorNode
  readonly gain: GainNode
  readonly when: number
}

export class WebAudioMetronome implements MetronomeSink {
  private readonly ctx: BaseAudioContext
  private readonly clock: Clock
  private volume: number
  private scheduled: Scheduled[] = []

  constructor(o: WebAudioMetronomeOptions) {
    this.ctx = o.context
    this.clock = o.clock
    this.volume = clamp01(o.volume ?? 0.6)
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume)
  }

  click(time: number, accent: boolean): void {
    const ctx = this.ctx
    const when = contextTimeFor(ctx, this.clock(), time)
    this.scheduled = this.scheduled.filter((s) => s.when > ctx.currentTime - 0.2)
    const src = ctx.createOscillator()
    const gain = ctx.createGain()
    src.type = 'sine'
    src.frequency.value = accent ? 1760 : 1320
    const peak = this.volume * (accent ? 0.9 : 0.6)
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(peak, when + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    src.connect(gain)
    gain.connect(ctx.destination)
    src.start(when)
    src.stop(when + 0.06)
    src.onended = () => gain.disconnect()
    this.scheduled.push({ src, gain, when })
  }

  cancel(now: number): void {
    const cutoff = contextTimeFor(this.ctx, now, now)
    for (const s of this.scheduled) {
      if (s.when > cutoff) {
        s.gain.disconnect()
        try {
          s.src.stop()
        } catch {
          // already stopped
        }
      }
    }
    this.scheduled = this.scheduled.filter((s) => s.when <= cutoff)
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}
