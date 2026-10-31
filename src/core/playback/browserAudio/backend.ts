/**
 * Browser-audio backend: the explicitly chosen alternative to the physical piano (spec
 * "MIDI input, output, and pedal controls": browser sound must never silently substitute for
 * the required instrument output). One shared AudioContext; events are scheduled against
 * the context clock from performance.now()-timebase times; Salamander samples with a synth
 * fallback; optional monitoring of the learner's keys (separate voices, off by default).
 *
 * This module, and the sample bank it loads, are reached only through a dynamic import, so
 * physical-MIDI practice never fetches or decodes the bank (spec "MIDI-only resource use").
 */
import type { MidiInputEvent } from '../../midi/types'
import type { Clock, OutputBackend } from '../types'
import { contextTimeFor } from '../webaudio/context'
import { type BankStats, type FetchLike, SampleBank } from './samples'
import { VoiceBank, sampleVoices } from './voices'

export interface BrowserAudioOptions {
  readonly context: BaseAudioContext
  readonly clock: Clock
  /** Folder URL of the sample bank, ending in '/'. */
  readonly baseUrl: string
  readonly fetch: FetchLike
  /** 0..1 master volume (Settings → Sound). Default 0.8. */
  readonly volume?: number
  readonly maxDecodedBytes?: number
  readonly maxSampleSeconds?: number
  readonly onProgress?: (stats: BankStats) => void
}

export class BrowserAudioBackend implements OutputBackend {
  readonly kind = 'browser' as const
  /** Browser events are handed out in time order across the whole lookahead window. */
  readonly offLookaheadMs = Number.POSITIVE_INFINITY

  private readonly ctx: BaseAudioContext
  private readonly clock: Clock
  private readonly master: GainNode
  private readonly bank: SampleBank
  private readonly app: VoiceBank
  private readonly monitorBank: VoiceBank

  constructor(o: BrowserAudioOptions) {
    this.ctx = o.context
    this.clock = o.clock
    this.master = o.context.createGain()
    this.master.gain.value = clamp01(o.volume ?? 0.8)
    this.master.connect(o.context.destination)
    this.bank = new SampleBank({
      context: o.context,
      baseUrl: o.baseUrl,
      fetch: o.fetch,
      ...(o.maxDecodedBytes !== undefined ? { maxDecodedBytes: o.maxDecodedBytes } : {}),
      ...(o.maxSampleSeconds !== undefined ? { maxSampleSeconds: o.maxSampleSeconds } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    })
    const voices = sampleVoices(o.context, this.bank, this.master)
    this.app = new VoiceBank(voices)
    this.monitorBank = new VoiceBank(voices)
  }

  /** Start loading the bank (the synth plays meanwhile). Never rejects. */
  load(): Promise<void> {
    return this.bank.load()
  }

  /** Transferred and decoded byte counts for the size/performance report. */
  stats(): BankStats {
    return this.bank.stats()
  }

  setVolume(volume: number): void {
    this.master.gain.value = clamp01(volume)
  }

  noteOn(note: number, velocity: number, time: number): void {
    this.app.noteOn(note, velocity, this.at(time))
  }

  noteOff(note: number, time: number): void {
    this.app.noteOff(note, this.at(time))
  }

  controlChange(controller: number, value: number, time: number): void {
    this.app.control(controller, value, this.at(time))
  }

  cleanup(): void {
    this.app.silence(this.ctx.currentTime)
  }

  stopSound(): void {
    this.app.silence(this.ctx.currentTime)
    this.monitorBank.silence(this.ctx.currentTime)
  }

  /**
   * Optional input monitoring for silent controllers (Settings → Sound, off by default):
   * sounds the learner's own keys and pedals immediately, separately from app playback.
   */
  monitor(ev: MidiInputEvent): void {
    const when = this.ctx.currentTime
    if (ev.kind === 'noteon') this.monitorBank.noteOn(ev.note, ev.velocity, when)
    else if (ev.kind === 'noteoff') this.monitorBank.noteOff(ev.note, when)
    else this.monitorBank.control(ev.controller, ev.value, when)
  }

  /** Disconnect from the shared context (the context itself stays for the metronome). */
  dispose(): void {
    this.stopSound()
    this.master.disconnect()
  }

  private at(time: number): number {
    return contextTimeFor(this.ctx, this.clock(), time)
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}
