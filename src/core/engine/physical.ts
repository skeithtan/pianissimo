/**
 * Physical key and pedal state, kept separate from accepted attacks and from sustained sound
 * (spec: "Track accepted attacks separately from physically held keys and pedal-sustained
 * sound"). A held key is never an attack; only a fresh Note On is.
 */
import { CC_SOSTENUTO, CC_SUSTAIN } from '../midi/types'

export class PhysicalState {
  readonly #held = new Map<number, number>()
  readonly #downThreshold: number
  #sustain = 0
  #sostenuto = 0

  constructor(pedalDownThreshold: number) {
    this.#downThreshold = pedalDownThreshold
  }

  keyDown(note: number, channel: number): void {
    this.#held.set(note, channel)
  }

  /** Returns true when the key was held. */
  keyUp(note: number): boolean {
    return this.#held.delete(note)
  }

  /** All Notes Off from the instrument: no individual releases will follow. Returns released keys. */
  releaseChannel(channel: number): number[] {
    const released: number[] = []
    for (const [note, ch] of this.#held) if (ch === channel) released.push(note)
    for (const note of released) this.#held.delete(note)
    return released
  }

  /** Records sound-retaining pedals (64 sustain, 66 sostenuto). Returns true when tracked. */
  pedal(controller: number, value: number): boolean {
    if (controller === CC_SUSTAIN) this.#sustain = value
    else if (controller === CC_SOSTENUTO) this.#sostenuto = value
    else return false
    return true
  }

  isHeld(note: number): boolean {
    return this.#held.has(note)
  }

  heldKeys(): number[] {
    return [...this.#held.keys()].sort((a, b) => a - b)
  }

  get anyKeyHeld(): boolean {
    return this.#held.size > 0
  }

  get sustain(): number {
    return this.#sustain
  }

  get sostenuto(): number {
    return this.#sostenuto
  }

  get sustainDown(): boolean {
    return this.#sustain >= this.#downThreshold
  }

  get sostenutoDown(): boolean {
    return this.#sostenuto >= this.#downThreshold
  }

  /** A sound-retaining pedal (sustain or sostenuto) is at or past the down threshold. */
  get pedalsDown(): boolean {
    return this.sustainDown || this.sostenutoDown
  }

  /** Forget everything (disconnect: releases sent while absent are lost). */
  reset(): void {
    this.#held.clear()
    this.#sustain = 0
    this.#sostenuto = 0
  }
}
