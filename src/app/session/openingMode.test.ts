import { describe, expect, it } from 'vitest'
import type { PieceRecord } from '../../core/storage/records'
import { isPractice, learnerHands, openingMode, type OpeningEnv } from './openingMode'

type Stored = Pick<PieceRecord, 'mode' | 'rhythm' | 'lastHands'>

const NEW: Stored = { lastHands: 'both' }
const CONNECTED: OpeningEnv = { pianoConnected: true, pianoRemembered: true, midiSupported: true }
const REMEMBERED: OpeningEnv = { pianoConnected: false, pianoRemembered: true, midiSupported: true }
const NO_PIANO: OpeningEnv = { pianoConnected: false, pianoRemembered: false, midiSupported: true }
const NO_MIDI: OpeningEnv = { pianoConnected: false, pianoRemembered: false, midiSupported: false }

describe('opening mode', () => {
  it('is the stored mode, whatever is connected and whatever older fields say', () => {
    for (const mode of ['listen', 'wait', 'time', 'follow'] as const) {
      for (const env of [CONNECTED, REMEMBERED, NO_PIANO]) {
        expect(openingMode({ ...NEW, mode }, env)).toBe(mode)
        expect(openingMode({ mode, rhythm: true, lastHands: 'none' }, env)).toBe(mode)
      }
    }
  })

  it('reads older records: Keep time, then both hands off as Listen', () => {
    expect(openingMode({ ...NEW, rhythm: true }, NO_PIANO)).toBe('time')
    expect(openingMode({ rhythm: true, lastHands: 'none' }, CONNECTED)).toBe('time')
    expect(openingMode({ lastHands: 'none' }, CONNECTED)).toBe('listen')
    expect(openingMode({ rhythm: false, lastHands: 'none' }, CONNECTED)).toBe('listen')
    expect(openingMode({ rhythm: false, lastHands: 'left' }, CONNECTED)).toBe('wait')
  })

  it('a new piece waits with a piano, connected or remembered, and listens without one', () => {
    expect(openingMode(NEW, CONNECTED)).toBe('wait')
    expect(openingMode(NEW, { ...NO_PIANO, pianoConnected: true })).toBe('wait')
    expect(openingMode(NEW, REMEMBERED)).toBe('wait')
    expect(openingMode(NEW, NO_PIANO)).toBe('listen')
  })

  it('without Web MIDI, Wait and Keep time open as Listen, stored or derived; Follow stays', () => {
    expect(openingMode({ ...NEW, mode: 'wait' }, NO_MIDI)).toBe('listen')
    expect(openingMode({ ...NEW, mode: 'time' }, NO_MIDI)).toBe('listen')
    expect(openingMode({ ...NEW, rhythm: true }, NO_MIDI)).toBe('listen')
    expect(openingMode(NEW, { ...NO_MIDI, pianoRemembered: true })).toBe('listen')
    expect(openingMode({ ...NEW, mode: 'follow' }, NO_MIDI)).toBe('follow')
    expect(openingMode({ ...NEW, mode: 'listen' }, NO_MIDI)).toBe('listen')
  })

  it('a passage to practice opens in Wait unless the piece is in Keep time', () => {
    for (const mode of ['listen', 'follow', 'wait'] as const)
      expect(openingMode({ ...NEW, mode }, NO_PIANO, true)).toBe('wait')
    expect(openingMode({ ...NEW, mode: 'time' }, NO_PIANO, true)).toBe('time')
    expect(openingMode(NEW, NO_PIANO, true)).toBe('wait')
    expect(openingMode({ ...NEW, mode: 'follow' }, NO_MIDI, true)).toBe('listen')
  })

  it('only Wait and Keep time are practice', () => {
    expect((['listen', 'wait', 'time', 'follow'] as const).map(isPractice)).toEqual([false, true, true, false])
  })

  it('reads an older "both hands off" as both hands', () => {
    expect(learnerHands('none')).toBe('both')
    expect((['both', 'left', 'right'] as const).map(learnerHands)).toEqual(['both', 'left', 'right'])
  })
})
