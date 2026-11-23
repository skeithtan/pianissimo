// @vitest-environment happy-dom
import { signal } from '@preact/signals'
import { afterEach, describe, expect, it } from 'vitest'
import { readMessagesWith, type Messages } from '../../i18n/messages'
import { barLabel, bindScoreLanguage, relabelBars, setBarLabel } from './scoreLanguage'

const ENGLISH: Messages = { language: 'en-US', strings: {} }
const FRENCH: Messages = { language: 'fr-FR', strings: { '{0} (pass {1})': '{0} (passage {1})' } }

afterEach(() => readMessagesWith(() => ENGLISH))

const SVG_NS = 'http://www.w3.org/2000/svg'
function number(o: { label: string; number?: string; pass?: number }): SVGTextElement {
  const t = document.createElementNS(SVG_NS, 'text')
  t.setAttribute('class', 'pn-mnum')
  setBarLabel(t, o)
  return t
}

describe('bar labels', () => {
  it('formats the bar number and pass in the current language', () => {
    expect(barLabel({ label: '12 (pass 2)', number: '12', pass: 2 })).toBe('12 (pass 2)')
    readMessagesWith(() => FRENCH)
    expect(barLabel({ label: '12 (pass 2)', number: '12', pass: 2 })).toBe('12 (passage 2)')
    expect(barLabel({ label: '12', number: '12', pass: 1 })).toBe('12')
  })

  it('draws the stored text of a layout cached without the parts', () => {
    readMessagesWith(() => FRENCH)
    expect(barLabel({ label: '12 (pass 2)' })).toBe('12 (pass 2)')
    const t = number({ label: '12 (pass 2)' })
    expect(t.textContent).toBe('12 (pass 2)')
    expect(t.hasAttribute('data-pass')).toBe(false)
  })

  it('translates the later passes again after a language change', () => {
    const root = document.createElement('div')
    const later = number({ label: '7 (pass 3)', number: '7', pass: 3 })
    const first = number({ label: '7', number: '7', pass: 1 })
    root.append(later, first)
    expect(later.textContent).toBe('7 (pass 3)')
    expect(first.hasAttribute('data-pass')).toBe(false)
    readMessagesWith(() => FRENCH)
    relabelBars(root)
    expect(later.textContent).toBe('7 (passage 3)')
    expect(first.textContent).toBe('7')
  })

  it('relabels the mounted numbers when the interface language changes', () => {
    const messages = signal<Messages>(ENGLISH)
    readMessagesWith(() => messages.value)
    const root = document.createElement('div')
    const later = number({ label: '4 (pass 2)', number: '4', pass: 2 })
    root.append(later)
    const stop = bindScoreLanguage(root, {})
    expect(later.textContent).toBe('4 (pass 2)')
    messages.value = FRENCH
    expect(later.textContent).toBe('4 (passage 2)')
    stop()
  })
})
