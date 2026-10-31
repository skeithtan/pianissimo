/**
 * In-memory Web Audio fakes for unit tests: only the members the browser-audio backend and
 * metronome use. Nodes record their scheduling calls. Not imported by application code.
 */

export class FakeParam {
  value: number
  readonly calls: Array<[string, ...number[]]> = []
  constructor(value = 1) {
    this.value = value
  }
  setValueAtTime(v: number, t: number): this {
    this.calls.push(['set', v, t])
    return this
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.calls.push(['linear', v, t])
    return this
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.calls.push(['exp', v, t])
    return this
  }
  setTargetAtTime(v: number, t: number, c: number): this {
    this.calls.push(['target', v, t, c])
    return this
  }
  cancelScheduledValues(t: number): this {
    this.calls.push(['cancel', t])
    return this
  }
  /** First time a release (target 0) was scheduled, or null. */
  releasedAt(): number | null {
    const c = this.calls.find((x) => x[0] === 'target' && x[1] === 0)
    return c ? c[2]! : null
  }
}

class FakeNode {
  readonly connections: unknown[] = []
  disconnected = false
  connect<T>(node: T): T {
    this.connections.push(node)
    return node
  }
  disconnect(): void {
    this.disconnected = true
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1)
}

class FakeScheduled extends FakeNode {
  startAt: number | null = null
  stopAt: number[] = []
  onended: (() => void) | null = null
  start(when = 0): void {
    this.startAt = when
  }
  stop(when = 0): void {
    this.stopAt.push(when)
  }
}

export class FakeBufferSource extends FakeScheduled {
  buffer: FakeAudioBuffer | null = null
  readonly playbackRate = new FakeParam(1)
}

export class FakeOscillator extends FakeScheduled {
  type = 'sine'
  readonly frequency = new FakeParam(440)
}

export class FakeAudioBuffer {
  private readonly data: Float32Array[]
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }
  get duration(): number {
    return this.length / this.sampleRate
  }
  getChannelData(c: number): Float32Array {
    return this.data[c]!
  }
}

export interface FakeDecodeSpec {
  readonly seconds: number
  /** Constant value per channel. */
  readonly channels: readonly number[]
}

export class FakeAudioContext {
  currentTime = 0
  state: 'running' | 'suspended' | 'closed' = 'running'
  readonly destination = new FakeNode()
  readonly gains: FakeGain[] = []
  readonly sources: FakeBufferSource[] = []
  readonly oscillators: FakeOscillator[] = []
  decodeCalls = 0

  constructor(
    readonly sampleRate = 48_000,
    readonly decodeSpec: FakeDecodeSpec = { seconds: 8, channels: [1, 0.5] },
  ) {}

  createGain(): FakeGain {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
  createBufferSource(): FakeBufferSource {
    const s = new FakeBufferSource()
    this.sources.push(s)
    return s
  }
  createOscillator(): FakeOscillator {
    const o = new FakeOscillator()
    this.oscillators.push(o)
    return o
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate)
  }
  decodeAudioData(_bytes: ArrayBuffer): Promise<FakeAudioBuffer> {
    this.decodeCalls++
    const { seconds, channels } = this.decodeSpec
    const b = new FakeAudioBuffer(channels.length, Math.round(seconds * this.sampleRate), this.sampleRate)
    channels.forEach((v, c) => b.getChannelData(c).fill(v))
    return Promise.resolve(b)
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
}

/** Typed view for code under test (the fake implements only what Pianissimo uses). */
export const asContext = (ctx: FakeAudioContext): BaseAudioContext => ctx as unknown as BaseAudioContext
