/** Parsing for the custom number fields in Settings (hint threshold and lifetime). */

export type NumberParse = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string }

/**
 * A positive number typed by the user. `integer` requires a whole number; `max` is an upper bound.
 * Rejects empty, unreadable, zero, negative and non-finite input with a short message.
 */
export function parsePositive(text: string, options: { integer?: boolean; max: number; what: string }): NumberParse {
  const t = text.trim().replace(',', '.')
  if (t === '') return { ok: false, error: `Enter ${options.what}.` }
  if (!/^\d*\.?\d+$|^\d+\.$/u.test(t)) return { ok: false, error: `"${text.trim()}" is not a number.` }
  const value = Number(t)
  if (!Number.isFinite(value)) return { ok: false, error: 'Enter a finite number.' }
  if (value <= 0) return { ok: false, error: `${capitalize(options.what)} must be greater than zero.` }
  if (options.integer && !Number.isInteger(value)) return { ok: false, error: 'Use a whole number.' }
  if (value > options.max) return { ok: false, error: `${capitalize(options.what)} can be at most ${options.max}.` }
  return { ok: true, value }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
