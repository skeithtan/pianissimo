/**
 * Dates and times (DECISIONS U165). No browser tells a page the device's date format or its 24-hour
 * switch: its default locale stands for the language alone, and even native date fields follow it. So
 * times are always on the 24-hour clock, and dates in English are day, month, year. Other languages keep
 * their own order. The words are the device's language.
 */

const two = (value: number) => String(value).padStart(2, '0')

export function timeOfDay(at: number | Date): string {
  const date = new Date(at)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** `locale` is for tests: the device's own otherwise. */
export function dateText(at: number | Date, options: Intl.DateTimeFormatOptions, locale?: string): string {
  const date = new Date(at)
  const format = new Intl.DateTimeFormat(locale, options)
  if (new Intl.Locale(format.resolvedOptions().locale).language !== 'en') return format.format(date)
  const parts = format.formatToParts(date)
  return ['weekday', 'day', 'month', 'year'].flatMap((t) => parts.find((p) => p.type === t)?.value ?? []).join(' ')
}
