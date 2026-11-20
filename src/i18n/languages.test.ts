import { afterEach, describe, expect, it } from 'vitest'
import { closestLanguage } from '../core/model/language'
import en from './locales/en-US.json'
import es from './locales/es-ES.json'
import fr from './locales/fr-FR.json'
import ca from './locales/fr-CA.json'
import fil from './locales/fil-PH.json'
import { importMessage } from './importMessage'
import { msg, percentage, readMessagesWith } from './messages'

afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

describe('interface languages', () => {
  it.each([
    [['it-IT', 'fr-CA', 'en'], 'fr-CA'],
    [['fr-CH', 'fr-CA'], 'fr-FR'],
    [['invalid_tag', 'es-AR'], 'es-ES'],
    [['ja-JP', 'tl'], 'fil-PH'],
    [['fil-PH'], 'fil-PH'],
    [['en-AU', 'es-ES'], 'en-US'],
    [['it-IT'], 'en-US'],
    [[], 'en-US'],
  ] as const)('matches the device preferences %j', (preferences, expected) => {
    expect(closestLanguage(preferences)).toBe(expected)
  })

  it('covers every message ID in each effective catalog', () => {
    for (const catalog of [es, fr, { ...fr, ...ca }, fil]) {
      expect(Object.keys(catalog)).toEqual(Object.keys(en))
      expect(Object.values(catalog).every((value) => value.trim().length > 0)).toBe(true)
      for (const [id, text] of Object.entries(catalog)) {
        const source = en[id as keyof typeof en]
        const fields = new Set(source.match(/\{\d+\}/g) ?? [])
        for (const field of text.match(/\{\d+\}/g) ?? []) expect(fields.has(field)).toBe(true)
      }
    }
    expect(new Set(Object.values(en)).size).toBe(Object.keys(en).length)
  })

  it('translates stored import diagnostics and treats interpolated titles as literal data', () => {
    const strings = Object.fromEntries(Object.entries(es).map(([id, value]) => [en[id as keyof typeof en], value]))
    readMessagesWith(() => ({ language: 'es-ES', strings }))
    expect(msg('Practice {0}', 'Settings')).toContain('Settings')
    expect(importMessage('Bar 41 is shorter than its time signature.')).toBe(
      msg('Bar {0} is shorter than its time signature.', 41),
    )
    expect(importMessage('Bar 41 is shorter than its time signature.')).not.toContain('shorter')
    const warning =
      'Voice 2 of “Settings” is the right hand, and 1 of its notes is written on the other staff (bars 3, 7).'
    expect(importMessage(warning)).toContain('mano derecha')
    expect(importMessage(warning)).toContain('compases 3, 7')
    expect(importMessage(warning)).toContain('Settings')
    expect(percentage(0.625)).toContain('62,5')
  })

  it('uses the requested spelling of Computer in Filipino', () => {
    const guide = Object.entries(en).find(([, source]) => source === 'Computer:')
    expect(fil[guide![0] as keyof typeof fil]).toBe('Computer:')
    expect(Object.values(fil).join(' ')).not.toMatch(/kompyuter/i)
  })

  it('keeps common untranslated interface terms out of Filipino', () => {
    const english =
      /\b(settings?|library|backup|device|browser|file|keyboard|click|playback|feedback|screen|score|practice|save|timer|output|input|download|upload|scroll|reset|default|performance)\b/i
    for (const text of Object.values(fil)) {
      // Exact names, XML element names and archive paths are copied from the score or hardware.
      const prose = text
        .replaceAll('MIDIWeb Browser', '')
        .replace(/<[^>]*>|META-INF\/container\.xml|score-partwise|score-timewise/g, '')
      expect(prose).not.toMatch(english)
    }
  })
})
