/**
 * Test helpers for interface languages: read messages from a real catalog, or from a
 * pseudo-catalog that marks every catalog string, and scan for visible text that did not come
 * through `msg`. Not imported by production code.
 *
 * Under the pseudo-catalog every translated template renders as ⟦…⟧ (arguments are filled in
 * inside the marks), so any letter outside a mark on screen or in an accessible name is English
 * that a translation could never replace.
 */
import type { Language } from '../../core/model/language'
import en from '../../i18n/locales/en-US.json'
import es from '../../i18n/locales/es-ES.json'
import fil from '../../i18n/locales/fil-PH.json'
import ca from '../../i18n/locales/fr-CA.json'
import fr from '../../i18n/locales/fr-FR.json'
import ja from '../../i18n/locales/ja-JP.json'
import { readMessagesWith } from '../../i18n/messages'

const translated: Readonly<Record<Exclude<Language, 'en-US'>, Readonly<Record<string, string>>>> = {
  'es-ES': es,
  'fr-FR': fr,
  'fr-CA': { ...fr, ...ca },
  'fil-PH': fil,
  'ja-JP': ja,
}

/** Read messages from one shipped catalog until the returned function restores US English. */
export function useCatalog(language: Language): () => void {
  const source: Readonly<Record<string, string>> = en
  const strings =
    language === 'en-US'
      ? {}
      : Object.fromEntries(Object.entries(translated[language]).map(([id, value]) => [source[id]!, value]))
  readMessagesWith(() => ({ language, strings }))
  return () => readMessagesWith(() => ({ language: 'en-US', strings: {} }))
}

const pseudo: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(en).map((source) => [source, `⟦${source}⟧`]),
)

/** Read messages from the pseudo-catalog until the returned function restores US English. */
export function usePseudoCatalog(): () => void {
  readMessagesWith(() => ({ language: 'es-ES', strings: pseudo }))
  return () => readMessagesWith(() => ({ language: 'en-US', strings: {} }))
}

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'aria-valuetext', 'alt'] as const
const LETTER = /\p{L}/u
const SEPARATOR = '\u0001'
/** SI unit symbols after a number ("8.1 s", "150 ms") are the same in every catalog language. */
const UNITS = /(?<=\d)\s?m?s\b/gu

/** Remove marked text, innermost first, so nested templates (an argument that is itself translated) go too. */
function stripMarks(text: string): string {
  let previous: string
  do {
    previous = text
    text = text.replace(/⟦[^⟦⟧]*⟧/gu, ' ')
  } while (text !== previous)
  return text
}

function unmarked(text: string, allow: readonly (string | RegExp)[]): boolean {
  let rest = stripMarks(text).replace(UNITS, ' ')
  for (const entry of allow)
    rest =
      typeof entry === 'string'
        ? rest.replaceAll(entry, ' ')
        : rest.replace(new RegExp(entry.source, entry.flags.includes('g') ? entry.flags : `${entry.flags}g`), ' ')
  return LETTER.test(rest)
}

/**
 * Every visible text run and accessible attribute under `root` that holds letters outside the
 * pseudo-catalog's marks. `allow` lists literal data: score titles, device names, note names.
 * Text runs are joined in document order before the marks are removed, so a template that the
 * view splits around an inline element still counts as marked.
 */
export function untranslatedText(root: Element, allow: readonly (string | RegExp)[] = []): string[] {
  const found: string[] = []
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const runs: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('style, script')) continue
    runs.push(node.nodeValue ?? '')
  }
  const joined = runs.join(SEPARATOR)
  const stripped = stripMarks(joined).split(SEPARATOR)
  for (const run of stripped) if (unmarked(run, allow)) found.push(`text: ${run.trim()}`)
  for (const element of [root, ...root.querySelectorAll('*')])
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value && unmarked(value, allow)) found.push(`${name}: ${value}`)
    }
  return found
}

/** Dates and times follow the device locale, not the interface language. */
export const DEVICE_DATES: readonly RegExp[] = [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/u, /\b[AP]M\b/u]
