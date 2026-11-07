/**
 * Fakes for session tests: manual clock + timers + frames, scripted MIDI, a recording strip,
 * flash, history and piece sinks. Not imported by application code.
 */
import type { MidiRouteEvent } from '../../core/midi/adapter'
import type { MidiInputEvent } from '../../core/midi/types'
import type { MidiOutputLike } from '../../core/midi/webmidi'
import type { AbandonEvent, AttemptRecord, PassageRange } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import type { Rational } from '../../core/music/rational'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { FakeOutput } from '../../core/midi/fakeWebMidi'
import { ManualClock, RecordingBackend } from '../../core/playback/testkit'
import { PracticeSession, type SessionOptions } from './PracticeSession'
import type { Selection } from './selection'
import type { CorrectionMark } from './corrections'
import type {
  FlashSink,
  FrameApi,
  MidiBackendLike,
  MidiSource,
  PiecePatch,
  SessionDeps,
  SessionSettings,
  StripSink,
} from './types'

export class ManualFrames implements FrameApi {
  private queue: { id: number; cb: (t: number) => void }[] = []
  private nextId = 1
  frames = 0
  constructor(private readonly clock: () => number) {}
  request(cb: (t: number) => void): unknown {
    const id = this.nextId++
    this.queue.push({ id, cb })
    return id
  }
  cancel(handle: unknown): void {
    this.queue = this.queue.filter((f) => f.id !== handle)
  }
  get pending(): number {
    return this.queue.length
  }
  /** Run one animation frame (callbacks requested during it wait for the next). */
  flush(): void {
    const q = this.queue
    this.queue = []
    if (q.length) this.frames++
    for (const f of q) f.cb(this.clock())
  }
}

export class FakeMidi implements MidiSource {
  private readonly listeners = new Set<(ev: MidiInputEvent) => void>()
  private readonly routes = new Set<(ev: MidiRouteEvent) => void>()
  readonly owners = new Set<() => void>()
  out: MidiOutputLike | null = new FakeOutput('out-1', 'Piano')
  private seq = 0

  subscribe(fn: (ev: MidiInputEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  onRoute(fn: (ev: MidiRouteEvent) => void): () => void {
    this.routes.add(fn)
    return () => this.routes.delete(fn)
  }
  registerSoundOwner(owner: () => void): () => void {
    this.owners.add(owner)
    return () => this.owners.delete(owner)
  }
  output(): MidiOutputLike | null {
    return this.out
  }
  get subscribers(): number {
    return this.listeners.size
  }
  emit(ev: MidiInputEvent): void {
    for (const fn of [...this.listeners]) fn(ev)
  }
  on(note: number, time: number, velocity = 80): void {
    this.emit({ kind: 'noteon', seq: ++this.seq, channel: 0, note, velocity, time, portId: 'in-1' })
  }
  off(note: number, time: number): void {
    this.emit({ kind: 'noteoff', seq: ++this.seq, channel: 0, note, velocity: 0, time, portId: 'in-1' })
  }
  cc(controller: number, value: number, time: number): void {
    this.emit({ kind: 'cc', seq: ++this.seq, channel: 0, controller, value, time, portId: 'in-1' })
  }
  route(ev: MidiRouteEvent): void {
    for (const fn of [...this.routes]) fn(ev)
  }
}

export class FakeStrip implements StripSink {
  cursor = 0
  targets: readonly number[] = []
  accepted: readonly number[] = []
  automatic: readonly number[] = []
  playback: readonly number[] = []
  subdued: 'L' | 'R' | null = null
  wrongMarker = false
  pulses = 0
  ottava: readonly number[] = []
  texts: ReadonlyMap<number, string> = new Map()
  opacity: ReadonlyMap<number, number> = new Map()
  opacityCalls = 0
  loop: PassageRange | null = null
  loopEditable = true
  browse = true
  visible: number[] = []
  setCursor(position: number): void {
    this.cursor = position
  }
  setTargets(notes: readonly number[]): void {
    this.targets = notes
  }
  setAccepted(notes: readonly number[]): void {
    this.accepted = notes
  }
  setAutomatic(notes: readonly number[]): void {
    this.automatic = notes
  }
  setPlaybackHighlights(notes: readonly number[]): void {
    this.playback = notes
  }
  setSubduedHand(hand: 'L' | 'R' | null): void {
    this.subdued = hand
  }
  setWrongMarker(on: boolean): void {
    this.wrongMarker = on
  }
  pulseWrong(): void {
    this.pulses++
  }
  earlyMarker = false
  setEarlyMarker(on: boolean): void {
    this.earlyMarker = on
  }
  /** The last `wrapTo` position (null until a Repeat pass wraps). */
  wrappedTo: number | null = null
  wraps = 0
  wrapTo(position: number): void {
    this.wrappedTo = position
    this.wraps++
  }
  setOttavaEmphasis(spans: readonly number[]): void {
    this.ottava = spans
  }
  setLabels(texts: ReadonlyMap<number, string>): void {
    this.texts = texts
  }
  setLabelOpacity(opacity: ReadonlyMap<number, number>): void {
    this.opacity = opacity
    this.opacityCalls++
  }
  setLoop(range: PassageRange | null): void {
    this.loop = range
  }
  setLoopEditable(editable: boolean): void {
    this.loopEditable = editable
  }
  setBrowseEnabled(enabled: boolean): void {
    this.browse = enabled
  }
  cursorAction = false
  setCursorAction(visible: boolean): void {
    this.cursorAction = visible
  }
  snaps: readonly Rational[] = []
  snapCalls = 0
  setSnapPositions(onsets: readonly Rational[]): void {
    if (onsets !== this.snaps) this.snapCalls++
    this.snaps = onsets
  }
  cursorDraggable = false
  setCursorDraggable(enabled: boolean): void {
    this.cursorDraggable = enabled
  }
  visibleLabels(): number[] {
    return this.visible
  }
  isBrowsing(): boolean {
    return false
  }
  corrections: readonly CorrectionMark[] = []
  correctionCalls = 0
  setCorrections(marks: readonly CorrectionMark[]): void {
    this.corrections = marks
    this.correctionCalls++
  }
  /** Calls of `flushFrame` (the session applies strip changes inside its own frame). */
  flushes = 0
  flushFrame(): void {
    this.flushes++
  }
}

export class FakeFlash implements FlashSink {
  hits: { now: number | undefined; until: number | undefined; soft: boolean }[] = []
  clears = 0
  hit(now?: number, untilMs?: number, options?: { readonly soft?: boolean }): void {
    this.hits.push({ now, until: untilMs, soft: options?.soft === true })
  }
  clear(): void {
    this.clears++
  }
}

/** A recording MIDI backend with the human-input hooks. */
export class FakeMidiBackend extends RecordingBackend implements MidiBackendLike {
  human: MidiInputEvent[] = []
  resets = 0
  lost = false
  humanInput(ev: MidiInputEvent): void {
    this.human.push(ev)
  }
  resetHuman(): void {
    this.resets++
  }
  disconnected(): void {
    this.lost = true
  }
  reconnect(): void {
    this.lost = false
  }
}

/** Settings with a verified, echo-free route (graded accompaniment allowed). */
export function testSettings(patch: Partial<SessionSettings> = {}): SessionSettings {
  const d = DEFAULT_SETTINGS
  return {
    naming: d.naming,
    labels: d.labels,
    hints: d.hints,
    pedal: d.pedal,
    route: { ...d.route, outputId: 'out-1', outputName: 'Piano', outputVerified: true, echo: 'none' },
    sound: d.sound,
    metronome: d.metronome,
    rhythm: d.rhythm,
    ...patch,
  }
}

export interface Harness {
  readonly session: PracticeSession
  readonly clock: ManualClock
  readonly frames: ManualFrames
  readonly midi: FakeMidi
  readonly strip: FakeStrip
  readonly flash: FakeFlash
  readonly backend: FakeMidiBackend
  readonly attempts: AttemptRecord[]
  readonly abandons: AbandonEvent[]
  readonly saves: { patch: PiecePatch; immediate: boolean }[]
  /** Advance time, then run one frame. */
  step(ms: number): void
  /** Press and release a key at the current time (then a frame). */
  tap(...notes: number[]): void
  /** Play pitches in order, waiting for the current target to reach its gate before each pitch. */
  play(...notes: number[]): void
  press(...notes: number[]): void
  release(...notes: number[]): void
}

export function harness(
  model: ScoreModel,
  selection: Partial<Selection> = {},
  opts: {
    settings?: SessionSettings
    attach?: boolean
    options?: Partial<SessionOptions>
    deps?: Partial<SessionDeps>
  } = {},
): Harness {
  const clock = new ManualClock()
  clock.now = 1000
  const frames = new ManualFrames(clock.clock)
  const midi = new FakeMidi()
  const strip = new FakeStrip()
  const flash = new FakeFlash()
  const backend = new FakeMidiBackend(clock.clock)
  const attempts: AttemptRecord[] = []
  const abandons: AbandonEvent[] = []
  const saves: { patch: PiecePatch; immediate: boolean }[] = []
  const session = new PracticeSession(
    {
      pieceId: 'p1',
      model,
      selection: { hands: 'both', range: null, multiplier: 1, ...selection },
      settings: opts.settings ?? testSettings(),
      // A passage in the selection opens Repeat mode (as a preset passage does, U10).
      repeat: selection.range != null,
      ...opts.options,
    },
    {
      clock: clock.clock,
      timers: clock,
      frames,
      midi,
      history: { queueAttempt: (r) => attempts.push(r), queueAbandon: (e) => abandons.push(e) },
      piece: { save: (patch, immediate = false) => saves.push({ patch, immediate }) },
      createMidiBackend: () => backend,
      ...opts.deps,
    },
  )
  if (opts.attach !== false) session.attachStrip(strip)
  session.attachFlash(flash)
  frames.flush()
  const h: Harness = {
    session,
    clock,
    frames,
    midi,
    strip,
    flash,
    backend,
    attempts,
    abandons,
    saves,
    step(ms) {
      clock.advance(ms)
      frames.flush()
    },
    tap(...notes) {
      for (const n of notes) {
        midi.on(n, clock.now)
        midi.off(n, clock.now)
      }
      frames.flush()
    },
    play(...notes) {
      for (const n of notes) {
        for (let elapsed = 0; elapsed < 60000; elapsed += 20) {
          const state = session.engine.state
          if (
            state.phase !== 'running' ||
            state.groupIndex === null ||
            state.transportGate >= state.groupIndex ||
            !state.missingPitches.includes(n)
          )
            break
          clock.advance(20)
        }
        midi.on(n, clock.now)
        midi.off(n, clock.now)
        frames.flush()
      }
    },
    press(...notes) {
      for (const n of notes) midi.on(n, clock.now)
      frames.flush()
    },
    release(...notes) {
      for (const n of notes) midi.off(n, clock.now)
      frames.flush()
    },
  }
  return h
}
