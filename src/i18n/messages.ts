import type { Language } from '../core/model/language'

export interface Messages {
  readonly language: Language
  readonly strings: Readonly<Record<string, string>>
}

const english: Messages = { language: 'en-US', strings: {} }
let current = () => english

/** The app supplies a reactive reader. Pure formatters and workers default to US English. */
export function readMessagesWith(read: () => Messages): void {
  current = read
}

export function messageLanguage(): Language {
  return current().language
}

const decimalFormats = new Map<Language, Intl.NumberFormat>()
const tenthsFormats = new Map<Language, Intl.NumberFormat>()
const percentFormats = new Map<Language, Intl.NumberFormat>()

export function decimal(value: number): string {
  const language = messageLanguage()
  if (language === 'en-US') return String(value)
  let format = decimalFormats.get(language)
  if (!format) {
    format = new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 12 })
    decimalFormats.set(language, format)
  }
  return format.format(value)
}

export function formatTenths(value: number): string {
  const language = messageLanguage()
  if (language === 'en-US') return value.toFixed(1)
  let format = tenthsFormats.get(language)
  if (!format) {
    format = new Intl.NumberFormat(language, { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 })
    tenthsFormats.set(language, format)
  }
  return format.format(value)
}

export function percentage(value: number): string {
  const language = messageLanguage()
  let format = percentFormats.get(language)
  if (!format) {
    format = new Intl.NumberFormat(language, { style: 'percent', useGrouping: false, maximumFractionDigits: 1 })
    percentFormats.set(language, format)
  }
  return format.format(value)
}

/** Arguments are literal data, including score titles. A translation may reorder them. */
export function msg(source: string, ...args: (string | number | null | undefined)[]): string {
  const { strings } = current()
  const pattern = Object.hasOwn(strings, source) ? strings[source]! : source
  return args.length
    ? pattern.replace(/\{(\d+)\}/g, (_, i: string) => {
        const value = args[Number(i)]
        return typeof value === 'number' ? decimal(value) : String(value ?? '')
      })
    : pattern
}

/** Counted units use a space in the Western locales and attach to the number in Japanese. */
export function plural(count: number, one: string, many = `${one}s`): string {
  const unit = msg(count === 1 ? one : many)
  return `${decimal(count)}${messageLanguage() === 'ja-JP' ? '' : ' '}${unit}`
}
