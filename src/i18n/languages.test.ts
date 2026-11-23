import { afterEach, describe, expect, it } from 'vitest'
import { closestLanguage } from '../core/model/language'
import en from './locales/en-US.json'
import es from './locales/es-ES.json'
import fr from './locales/fr-FR.json'
import ca from './locales/fr-CA.json'
import ja from './locales/ja-JP.json'
import fil from './locales/fil-PH.json'
import { importMessage } from './importMessage'
import { msg, percentage, readMessagesWith } from './messages'

afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

describe('interface languages', () => {
  it.each([
    [['it-IT', 'fr-CA', 'en'], 'fr-CA'],
    [['fr-CH', 'fr-CA'], 'fr-FR'],
    [['invalid_tag', 'es-AR'], 'es-ES'],
    [['ko-KR', 'tl'], 'fil-PH'],
    [['ja-JP', 'tl'], 'ja-JP'],
    [['ko', 'ja'], 'ja-JP'],
    [['ja-US', 'en-US'], 'ja-JP'],
    [['fil-PH'], 'fil-PH'],
    [['en-AU', 'es-ES'], 'en-US'],
    [['it-IT'], 'en-US'],
    [[], 'en-US'],
  ] as const)('matches the device preferences %j', (preferences, expected) => {
    expect(closestLanguage(preferences)).toBe(expected)
  })

  it('covers every message ID in each effective catalog', () => {
    for (const catalog of [es, fr, { ...fr, ...ca }, fil, ja]) {
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

  it('translates the details of an unsupported region inside an import warning', () => {
    const strings = Object.fromEntries(Object.entries(es).map(([id, value]) => [en[id as keyof typeof en], value]))
    readMessagesWith(() => ({ language: 'es-ES', strings }))
    const warning =
      'Repeat instruction that is not followed (D.S. al Coda: no segno before it, trill-mark) in bars 3–5: viewable, but scored practice is disabled there.'
    expect(importMessage(warning)).toBe(
      'Indicación de repetición no interpretada (D.S. al Coda: falta el segno anterior, trill-mark) en compases 3–5: puedes ver este pasaje, pero no se evaluará.',
    )
  })

  it('keeps the pedal state, the roll direction and the pedal threshold apart in Japanese', () => {
    const japanese = (source: string) =>
      ja[Object.entries(en).find(([, text]) => text === source)![0] as keyof typeof ja]
    // Meter.tsx: the pedal is down (pressed) or up (released).
    expect([japanese('Down'), japanese('Up'), japanese('{0}, down'), japanese('{0}, up')]).toEqual([
      '踏んでいる',
      '離している',
      '{0}、踏んでいる',
      '{0}、離している',
    ])
    // ImportSummary.tsx: a chord rolled downward or upward.
    expect([japanese('down'), japanese('up')]).toEqual(['下行', '上行'])
    expect([japanese('Threshold'), japanese('Threshold {0}')]).toEqual(['しきい値', 'しきい値：{0}'])
  })

  it('uses one term per concept in Japanese and Filipino', () => {
    const japanese = Object.values(ja).join('\n')
    expect(japanese).not.toMatch(/プレビュー/u) // Preview and Listen are 試聴
    expect(japanese).not.toMatch(/[0-9０-９]+分音符/u) // note values are written 四分音符
    expect(japanese).not.toMatch(/〜/u) // ranges use ～
    const filipino = Object.values(fil).join('\n')
    expect(filipino).not.toMatch(/tanda ng sukat/u) // a time signature is a palakumpasan; sukat is a bar
    // Save is I-save, never Itala or Itago; Itago means hide.
    expect(filipino).not.toMatch(/\bItala\b/u)
    const filipinoFor = (source: string) =>
      fil[Object.entries(en).find(([, text]) => text === source)![0] as keyof typeof fil]
    expect([filipinoFor('Save'), filipinoFor('Save changes'), filipinoFor('Hide')]).toEqual([
      'I-save',
      'I-save ang mga pagbabago',
      'Itago',
    ])
  })

  it('keeps the retired Filipino coinages and respellings out of the catalog', () => {
    // Everyday technology words are English loanwords spelled as in English, Spanish borrowings are
    // spelled as in Spanish, and each concept has one term. Stems match inside affixed forms; words
    // match whole, with or without a linker.
    const stems = [
      // coinages and rare words, with the term that replaced them
      'pambuklat', // browser
      'talaksan', // file
      'aparato', // device
      'pananggalang', // backup
      'pagtatakda', // Mga Setting, setting
      'pang-ugnay', // interface
      'nakaugnay', // nakakabit (Ugnayan stays as the Connection section)
      'iniuugnay', // ikinakabit
      'mag-ugnay', // magkabit
      'kinalabasan', // resulta
      'pinasiksik', // naka-compress
      'siksik', // compression
      'buklat', // i-extract
      'tagapasok', // import worker, import client
      'pagpasok', // pag-import
      'suliranin', // problema
      'tunguhin', // layunin
      'panubok', // pansubok
      'tibayin', // i-confirm (pagtibayin)
      'patibay', // i-confirm (pagpapatibay)
      'pansulat ng nota', // notation program
      'sulatan ng tirahan', // address bar
      'pindutan', // tecla (piano key), button
      // English loanwords respelled phonetically
      'rekord', // record, recording
      'koneksiyon', // connection
      'koneksyon',
      'konekta', // ikabit, online
      'awtomatik', // kusa, Auto
      'mikropono', // microphone
      'lisensiya', // licencia
      'license', // licencia
      'bersiyon', // version
      // Spanish borrowings respelled phonetically
      'piyano', // piano
      'piyesa', // pieza
      'tiyempo', // tiempo
      'teklado', // teclado
      'oktaba', // octava
      'akorde', // acorde
      'arpehiyo', // arpegio
      'bekuwadro', // becuadro
      'detalye', // detalle
      'puwesto', // puesto
      'puwede', // puede
      'porsiyento', // por ciento
    ]
    const words = [
      'kagamitan', // device
      'tabing', // screen
      'pasukan', // input
      'labasan', // output
      'daluyan', // channel, port
      'pook', // site
      'sagisag', // icon
      'imbakan', // storage
      'espasyo', // storage
      'likuran', // background
      'sisidlan', // container
      'kalipunan', // package
      'huwaran', // model
      'lagusan', // shortcut
      'pang-angkop', // adapter
      'tulis', // pin
      'tudling', // column
      'hulihan', // extension
      'panturo', // cursor
      'kaladkarin', // i-drag
      'pangkontrol', // controller
      'pangtunog', // audio
      'maylikha', // compositor
      'bintana', // window
      'pahina', // page
      'iskor', // score
      'memorya', // memory
      'bolyum', // volume
      'yunit', // unit
      'aktuwal', // actual
      'aktibo', // active
      'orihinal', // original
      'teksto', // text
      'pribado', // private (window)
      'direksiyon', // direction
      'musika', // musica
      'pwede', // puede
      'negatibo', // negativo
      'positibo', // positivo
      'ranggo', // rango
      'krus', // cruz
      'sero', // cero
      'kable', // cable
      'kontrol', // control
      'milyon', // millon
      'mensahe', // mensaje
      'kopya', // copia
      'baho', // bajo
      'mesosoprano', // mezzosoprano
      'parejo', // pareho, the everyday word
    ]
    const retired = new RegExp(`${stems.join('|')}|(?<![\\p{L}-])(?:${words.join('|')})(?:ng|g)?(?![\\p{L}])`, 'iu')
    const found = Object.entries(fil).filter(([, text]) => retired.test(text))
    expect(found).toEqual([])
  })

  it('uses curly quotes in Filipino, never guillemets', () => {
    for (const text of Object.values(fil)) expect(text).not.toMatch(/[«»]/u)
  })

  it('spaces French punctuation: no-break before colons and inside guillemets, narrow before ; ? !', () => {
    for (const text of Object.values(fr)) expect(text).not.toMatch(/ [:;?!»]|« /u)
    const canada = { ...fr, ...ca }
    for (const text of Object.values(canada)) {
      expect(text).not.toMatch(/ [:»]|« /u)
      expect(text).not.toMatch(/[ \u00a0\u202f][;?!]/u)
    }
  })

  it('uses the requested spelling of Computer in Filipino', () => {
    const guide = Object.entries(en).find(([, source]) => source === 'Computer:')
    expect(fil[guide![0] as keyof typeof fil]).toBe('Computer:')
    expect(Object.values(fil).join(' ')).not.toMatch(/kompyuter/i)
  })
})
