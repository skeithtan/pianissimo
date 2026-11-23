// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimingCue } from './timingCue'

let host: HTMLElement
let score: HTMLElement
let cursor: HTMLElement
let cue: TimingCue

beforeEach(() => {
  host = document.createElement('div')
  score = document.createElement('div')
  score.className = 'pn-strip'
  cursor = document.createElement('div')
  cursor.className = 'pn-cursor-bar'
  score.append(cursor)
  document.body.append(host)
  cue = new TimingCue(host, score, cursor)
})

afterEach(() => {
  cue.destroy()
  host.remove()
  vi.restoreAllMocks()
})

const frame = () => host.querySelector<HTMLElement>('.pn-score-viewport')!
const pill = () => host.querySelector<HTMLElement>('[data-testid="timing-cue"]')!

describe('TimingCue', () => {
  it('wraps the score in the viewport frame with the pill in a status layer', () => {
    expect(frame().firstElementChild).toBe(score)
    expect(host.querySelector('.pn-timing-layer')!.getAttribute('role')).toBe('status')
    expect(pill().querySelector('.pn-timing-sweep')).not.toBeNull()
    expect(pill().querySelectorAll('.pn-timing-chevron')).toHaveLength(4)
  })

  it('writes the direction on the pill and the cursor bar, never on the frame around the score', () => {
    expect(cue.set('rushing', true)).toBe(true)
    expect(pill().dataset.direction).toBe('rushing')
    expect(cursor.dataset.timing).toBe('rushing')
    expect(frame().hasAttribute('data-timing-direction')).toBe(false)
    expect(frame().hasAttribute('data-timing-enabled')).toBe(true)
    expect(pill().querySelector('.pn-timing-label')!.textContent).toBe('Rushing')

    expect(cue.set('dragging', true)).toBe(true)
    expect(pill().dataset.direction).toBe('dragging')
    expect(cursor.dataset.timing).toBe('dragging')
    expect(pill().querySelector('.pn-timing-label')!.textContent).toBe('Dragging')

    expect(cue.set(null, true)).toBe(true)
    expect(pill().hasAttribute('data-direction')).toBe(false)
    expect(cursor.hasAttribute('data-timing')).toBe(false)
    expect(frame().hasAttribute('data-timing-direction')).toBe(false)
    expect(cue.visible).toBe(false)
    expect(cue.active).toBe(true)
  })

  it('reports and writes nothing when nothing changed', () => {
    cue.set('rushing', true)
    const observer = new MutationObserver(() => undefined)
    observer.observe(host, { attributes: true, subtree: true, childList: true, characterData: true })
    expect(cue.set('rushing', true)).toBe(false)
    cue.place(300, 900, 120)
    observer.takeRecords()
    cue.place(300, 900, 120)
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
  })

  it('reports a change of the reserved row alone', () => {
    expect(cue.set(null, true)).toBe(true)
    expect(cue.set(null, true)).toBe(false)
    expect(cue.set(null, false)).toBe(true)
    expect(frame().hasAttribute('data-timing-enabled')).toBe(false)
  })

  it('follows the playhead horizontally, clamped at the edges, above the score top or in the row', () => {
    cue.set('dragging', true)
    cue.place(300.4, 900, 120)
    expect(pill().style.transform).toBe('translate3d(300px, 76px, 0)')
    cue.place(10, 900, 120)
    expect(pill().style.transform).toBe('translate3d(87px, 76px, 0)')
    cue.place(895, 900, 120)
    expect(pill().style.transform).toBe('translate3d(813px, 76px, 0)')
    // A score reaching the top edge: the reserved row above it.
    cue.place(300, 900, 0)
    expect(pill().style.transform).toBe('translate3d(300px, -38px, 0)')
  })

  it('remembers the place while hidden, so a new cue is in place before it is painted', () => {
    cue.set('rushing', true)
    cue.place(300, 900, 120)
    cue.set(null, true)
    // The view keeps reporting while the pill is hidden; nothing is written to it meanwhile.
    cue.place(420, 900, 120)
    expect(pill().style.transform).toBe('translate3d(300px, 76px, 0)')
    cue.set('dragging', true)
    expect(pill().style.transform).toBe('translate3d(420px, 76px, 0)')
    expect(pill().style.visibility).toBe('')
  })

  it('keeps a cue shown before the first place hidden until it is placed', () => {
    cue.set('rushing', true)
    expect(pill().style.visibility).toBe('hidden')
    expect(pill().style.transform).toBe('')
    cue.place(300, 900, 120)
    expect(pill().style.visibility).toBe('')
    expect(pill().style.transform).toBe('translate3d(300px, 76px, 0)')
  })

  it('removes its frame, with the score inside, on destroy', () => {
    cue.destroy()
    expect(host.querySelector('.pn-score-viewport')).toBeNull()
    expect(score.isConnected).toBe(false)
    // A second destroy (afterEach) is harmless.
  })
})
