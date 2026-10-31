import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MidiSnapshot } from '../../app/services'
import { DEFAULT_SETTINGS, type MidiRouteSettings } from '../../core/model/settings'
import {
  accessStatus,
  echoStatus,
  inputStatus,
  outputStatus,
  pedalStatus,
  playbackReadiness,
  playbackStatus,
} from './status'
import { eventRow, meterBehavior, pedalName } from './format'
import { velocityOpacity } from './MiniKeyboard'

const base: MidiSnapshot = {
  access: 'granted',
  message: '',
  permission: 'granted',
  inputs: [],
  outputs: [],
  input: null,
  output: null,
}
const port = (connected = true) => ({ id: 'p', name: 'Digital Piano', connected, matchedBy: 'pick' as const })
const route = (patch: Partial<MidiRouteSettings> = {}): MidiRouteSettings => ({ ...DEFAULT_SETTINGS.route, ...patch })

describe('step statuses', () => {
  it('access', () => {
    expect(accessStatus({ ...base, access: 'unsupported' })).toEqual({
      tone: 'blocked',
      text: 'Not available in this browser',
    })
    expect(accessStatus({ ...base, access: 'denied' }).tone).toBe('action')
    expect(accessStatus({ ...base, access: 'idle', permission: 'denied' }).text).toBe('Blocked by the browser')
    expect(accessStatus(base)).toEqual({ tone: 'done', text: 'Allowed' })
  })

  it('input', () => {
    expect(inputStatus({ ...base, access: 'idle' }).tone).toBe('blocked')
    expect(inputStatus(base).text).toBe('No MIDI input found')
    expect(inputStatus({ ...base, input: port() })).toEqual({ tone: 'done', text: 'Digital Piano' })
    expect(inputStatus({ ...base, input: port(false) })).toEqual({
      tone: 'action',
      text: 'Digital Piano is disconnected',
    })
  })

  it('output needs the test note before it counts as done', () => {
    expect(outputStatus(base, route()).text).toBe('No output chosen')
    expect(outputStatus({ ...base, output: port() }, route())).toEqual({ tone: 'action', text: 'Play the test note' })
    expect(outputStatus({ ...base, output: port() }, route({ outputVerified: true, outputChannel: 1 }))).toEqual({
      tone: 'done',
      text: 'Piano sounds on channel 2',
    })
  })

  it('echo needs both ports', () => {
    expect(echoStatus({ ...base, input: port() }, route()).tone).toBe('blocked')
    const both = { ...base, input: port(), output: port() }
    expect(echoStatus(both, route()).text).toBe('Not tested')
    expect(echoStatus(both, route({ echo: 'echo-detected' })).tone).toBe('action')
    expect(echoStatus(both, route({ echo: 'none' })).tone).toBe('done')
  })

  it('hint pedal is optional', () => {
    expect(pedalStatus(DEFAULT_SETTINGS)).toEqual({ tone: 'optional', text: 'Optional' })
    const mapping = {
      channel: 0,
      controller: 66,
      threshold: 64,
      inverted: false,
      observedMin: 0,
      observedMax: 127,
      verified: true,
    }
    expect(pedalStatus({ ...DEFAULT_SETTINGS, pedal: { ...DEFAULT_SETTINGS.pedal, hintPedal: mapping } }).text).toBe(
      'Sostenuto (middle pedal)',
    )
  })
})

describe('playbackReadiness (spec: graded accompaniment needs a verified, echo-free route)', () => {
  const snap = { ...base, input: port(), output: port() }
  it('requires a connected, verified output and echo none', () => {
    expect(playbackReadiness(snap, route()).graded).toBe(false)
    expect(playbackReadiness(snap, route({ outputId: 'p', outputVerified: true })).pianoPlayback).toBe(true)
    expect(playbackReadiness(snap, route({ outputId: 'p', outputVerified: true, echo: 'echo-detected' })).graded).toBe(
      false,
    )
    const ready = playbackReadiness(snap, route({ outputId: 'p', outputVerified: true, echo: 'none' }))
    expect(ready.graded).toBe(true)
    expect(ready.items.every((i) => i.ok)).toBe(true)
    expect(
      playbackReadiness({ ...snap, output: port(false) }, route({ outputId: 'p', outputVerified: true, echo: 'none' }))
        .graded,
    ).toBe(false)
    expect(playbackStatus(snap, route({ outputId: 'p', outputVerified: true })).text).toBe('Preview only')
  })
})

describe('live test text', () => {
  it('formats events and controller behavior', () => {
    const naming = DEFAULT_SETTINGS.naming
    expect(
      eventRow({ kind: 'noteon', seq: 1, channel: 0, note: 61, velocity: 87, time: 0, portId: '' }, naming),
    ).toEqual({
      kind: 'Note on',
      what: 'C♯4 (61)',
      value: 'vel 87',
      channel: 'ch 1',
    })
    expect(
      eventRow({ kind: 'cc', seq: 2, channel: 1, controller: 66, value: 0, time: 0, portId: '' }, naming).what,
    ).toBe('Sostenuto (CC 66)')
    expect(pedalName(11)).toBe('Controller 11')
    expect([1, 2, 3].map((distinct) => meterBehavior({ distinct }))).toEqual([
      'One value so far',
      'On/off',
      'Continuous',
    ])
    expect(velocityOpacity(0)).toBeCloseTo(0.35)
    expect(velocityOpacity(127)).toBe(1)
  })
})

describe('connection.module.css (U1, dark mode)', () => {
  it('uses theme tokens only: no literal colors outside var() fallbacks', () => {
    const css = readFileSync(new URL('./connection.module.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/var\(--[\w-]+(?:,[^()]*)?\)/g, 'TOKEN')
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(|\b(?:white|black)\b(?![-\w])/gi)).toBeNull()
  })
})
