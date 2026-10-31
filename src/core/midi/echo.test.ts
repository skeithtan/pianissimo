import { describe, expect, it } from 'vitest'
import { MidiAdapter } from './adapter'
import { DEFAULT_PROBE, EchoDetector, echoSetting, runEchoTest } from './echo'
import { FakeAccess, FakeInput, FakeOutput, fakeNavigator } from './fakeWebMidi'
import type { MidiInputEvent } from './types'

let seq = 0
const on = (note: number, velocity: number, time: number, channel = 0): MidiInputEvent => ({
  kind: 'noteon',
  seq: ++seq,
  channel,
  note,
  velocity,
  time,
  portId: 'in',
})

describe('EchoDetector (spec "Output echo and ownership")', () => {
  it('sends a distinctive three-note probe on the tested channel with timestamps', () => {
    const d = new EchoDetector({ channel: 3 })
    const msgs = d.messages(1000)
    expect(
      msgs.filter((m) => (m.data[0]! & 0xf0) === 0x90).map((m) => [m.data[0], m.data[1], m.data[2], m.time]),
    ).toEqual([
      [0x93, 61, 37, 1000],
      [0x93, 66, 83, 1220],
      [0x93, 70, 59, 1440],
    ])
    expect(msgs.filter((m) => (m.data[0]! & 0xf0) === 0x80)).toHaveLength(3)
    expect(d.durationMs).toBe(1440)
  })

  it('reports none when nothing returns', () => {
    const d = new EchoDetector({ channel: 0 })
    d.begin(0)
    expect(d.result()).toEqual({ verdict: 'none', returned: 0, exactMatch: false, latencyMs: null, otherInput: false })
  })

  it('detects returning probe notes (any channel) with latency', () => {
    const d = new EchoDetector({ channel: 0 })
    d.begin(0)
    for (const p of DEFAULT_PROBE) d.feed(on(p.note, p.velocity, p.offsetMs + 12, 5))
    expect(d.result()).toMatchObject({ verdict: 'echo-detected', returned: 3, exactMatch: false, latencyMs: 12 })
  })

  it('one exact echo (pitch, channel, velocity) is enough', () => {
    const d = new EchoDetector({ channel: 2 })
    d.begin(0)
    d.feed(on(61, 37, 8, 2))
    expect(d.result()).toMatchObject({ verdict: 'echo-detected', exactMatch: true })
  })

  it('a single matching pitch at another velocity is inconclusive (could be a human press)', () => {
    const d = new EchoDetector({ channel: 0 })
    d.begin(0)
    d.feed(on(66, 64, 300))
    d.feed(on(40, 70, 400))
    expect(d.result()).toMatchObject({ verdict: 'inconclusive', returned: 1, otherInput: true })
    expect(echoSetting('inconclusive')).toBeNull()
    expect(echoSetting('echo-detected')).toBe('echo-detected')
  })

  it('ignores notes outside the window and before the test', () => {
    const d = new EchoDetector({ channel: 0, windowMs: 500 })
    d.feed(on(61, 37, 0))
    d.begin(1000)
    d.feed(on(61, 37, 900))
    d.feed(on(61, 37, 1700))
    expect(d.result().verdict).toBe('none')
  })
})

describe('runEchoTest through the adapter', () => {
  it('sends the probe, still delivers human presses to other subscribers, then resolves', async () => {
    const access = new FakeAccess()
    const input = access.addInput(new FakeInput('in', 'Piano'))
    const output = access.addOutput(new FakeOutput('out', 'Piano'))
    let now = 1000
    const adapter = new MidiAdapter({ navigator: fakeNavigator(access), now: () => now })
    await adapter.request()
    adapter.selectInput('in')
    const live: number[] = []
    adapter.subscribe((ev) => live.push(ev.seq))
    let fire: (() => void) | null = null
    const done = runEchoTest(
      {
        send: (d, t) => output.send(d, t),
        subscribe: (fn) => adapter.subscribe(fn),
        now: () => now,
        setTimeout: (fn) => (fire = fn),
      },
      { channel: 0 },
    )
    expect(output.sent).toHaveLength(6)
    // The piano echoes the probe (MIDI thru) and a human also presses a key.
    input.emit([0x90, 61, 37], 1010)
    input.emit([0x90, 66, 83], 1230)
    input.emit([0x90, 48, 70], 1300)
    now = 2500
    fire!()
    const result = await done
    expect(result.verdict).toBe('echo-detected')
    expect(result.otherInput).toBe(true)
    expect(live).toEqual([1, 2, 3])
  })
})
