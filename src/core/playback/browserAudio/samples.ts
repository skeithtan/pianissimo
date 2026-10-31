/**
 * Salamander Grand Piano sample bank for the explicit browser-audio alternative (DECISIONS
 * S1; spec "Performance targets": a compact bank of at most 8 MB transferred and 32 MiB of
 * decoded PCM, reporting both values).
 *
 * Every sample is decoded, downmixed to mono and truncated so the whole bank fits the decoded
 * budget (at most 5 s each, with a short fade where cut). The stereo decode is dropped right
 * away. Missing or failed samples leave gaps that the voice factory fills with the synth.
 */

export interface SampleManifest {
  readonly samples: Readonly<Record<string, number>>
  readonly extension: string
}

export interface LoadedSample {
  readonly midi: number
  readonly buffer: AudioBuffer
}

export type BankStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'failed'

export interface BankStats {
  readonly status: BankStatus
  /** Bytes fetched over the network (compressed files plus manifest). */
  readonly transferredBytes: number
  /** Bytes of decoded PCM kept in memory (mono Float32). */
  readonly decodedBytes: number
  readonly loaded: number
  readonly failed: number
  readonly total: number
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

export interface SampleBankOptions {
  readonly context: BaseAudioContext
  /** Folder URL ending in '/', e.g. `${BASE_URL}samples/salamander/`. */
  readonly baseUrl: string
  readonly fetch: FetchLike
  /** Default 32 MiB. */
  readonly maxDecodedBytes?: number
  /** Default 5 s. */
  readonly maxSampleSeconds?: number
  /** Fade applied where a sample is cut. Default 0.08 s. */
  readonly fadeSeconds?: number
  /** Parallel downloads. Default 4. */
  readonly concurrency?: number
  /** Called after each sample settles. */
  readonly onProgress?: (stats: BankStats) => void
}

export const DECODED_BUDGET_BYTES = 32 * 1024 * 1024

/**
 * Mono, length-capped copy of a decoded buffer: channels averaged, cut to `maxFrames` with a
 * linear fade over the last `fadeFrames` when cut.
 */
export function monoTruncate(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  maxFrames: number,
  fadeFrames: number,
): AudioBuffer {
  const frames = Math.max(1, Math.min(src.length, Math.floor(maxFrames)))
  const out = ctx.createBuffer(1, frames, src.sampleRate)
  const dst = out.getChannelData(0)
  const channels = src.numberOfChannels
  for (let c = 0; c < channels; c++) {
    const data = src.getChannelData(c)
    for (let i = 0; i < frames; i++) dst[i]! += data[i]! / channels
  }
  if (frames < src.length) {
    const fade = Math.min(frames, Math.max(1, Math.floor(fadeFrames)))
    for (let i = 0; i < fade; i++) dst[frames - fade + i]! *= 1 - (i + 1) / fade
  }
  return out
}

export class SampleBank {
  private readonly o: SampleBankOptions
  private samples: LoadedSample[] = []
  private statusValue: BankStatus = 'idle'
  private transferred = 0
  private decoded = 0
  private failedCount = 0
  private total = 0
  private loading: Promise<void> | null = null

  constructor(options: SampleBankOptions) {
    this.o = options
  }

  stats(): BankStats {
    return {
      status: this.statusValue,
      transferredBytes: this.transferred,
      decodedBytes: this.decoded,
      loaded: this.samples.length,
      failed: this.failedCount,
      total: this.total,
    }
  }

  /** Start (or join) loading. Never rejects: failures leave the synth in place. */
  load(): Promise<void> {
    this.loading ??= this.run()
    return this.loading
  }

  /** Nearest loaded sample within `maxDistance` semitones, or null. */
  nearest(midi: number, maxDistance = 6): LoadedSample | null {
    let best: LoadedSample | null = null
    for (const s of this.samples) {
      const d = Math.abs(s.midi - midi)
      if (d <= maxDistance && (!best || d < Math.abs(best.midi - midi))) best = s
    }
    return best
  }

  private async run(): Promise<void> {
    this.statusValue = 'loading'
    let manifest: SampleManifest
    try {
      const res = await this.o.fetch(`${this.o.baseUrl}manifest.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      this.transferred += bytes.byteLength
      manifest = parseManifest(new TextDecoder().decode(bytes))
    } catch {
      this.statusValue = 'failed'
      this.progress()
      return
    }
    const entries = Object.entries(manifest.samples).sort((a, b) => a[1] - b[1])
    this.total = entries.length
    const sr = this.o.context.sampleRate
    const perSample = (this.o.maxDecodedBytes ?? DECODED_BUDGET_BYTES) / Math.max(1, entries.length)
    const maxSeconds = Math.min(this.o.maxSampleSeconds ?? 5, perSample / 4 / sr)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const [name, midi] = entries[next++]!
        try {
          const res = await this.o.fetch(`${this.o.baseUrl}${name}.${manifest.extension}`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const bytes = await res.arrayBuffer()
          this.transferred += bytes.byteLength
          const decoded = await this.o.context.decodeAudioData(bytes)
          const mono = monoTruncate(
            this.o.context,
            decoded,
            maxSeconds * decoded.sampleRate,
            (this.o.fadeSeconds ?? 0.08) * decoded.sampleRate,
          )
          this.decoded += mono.length * 4
          this.samples = [...this.samples, { midi, buffer: mono }].sort((a, b) => a.midi - b.midi)
        } catch {
          this.failedCount++
        }
        this.progress()
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, this.o.concurrency ?? 4) }, worker))
    this.statusValue = this.failedCount === 0 ? 'ready' : this.samples.length > 0 ? 'partial' : 'failed'
    this.progress()
  }

  private progress(): void {
    this.o.onProgress?.(this.stats())
  }
}

export function parseManifest(text: string): SampleManifest {
  const raw = JSON.parse(text) as { samples?: unknown; extension?: unknown }
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.extension !== 'string' ||
    !raw.samples ||
    typeof raw.samples !== 'object'
  ) {
    throw new Error('Invalid sample manifest')
  }
  const samples: Record<string, number> = {}
  for (const [name, midi] of Object.entries(raw.samples as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9]+$/.test(name) || typeof midi !== 'number' || !Number.isInteger(midi) || midi < 0 || midi > 127) {
      throw new Error(`Invalid sample entry ${name}`)
    }
    samples[name] = midi
  }
  return { samples, extension: raw.extension.replace(/[^a-z0-9]/gi, '') }
}
