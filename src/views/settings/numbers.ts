import { msg } from '../../i18n/messages'
/** Parsing for the custom number fields in Settings (hint threshold and lifetime). */

export type NumberParse = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string }

/** Shortest custom hint lifetime in seconds; the settings normalizer replaces anything smaller. */
export const MIN_HINT_LIFETIME_SECONDS = 0.1

/**
 * A positive number typed by the user. `integer` requires a whole number; `min` and `max` are
 * inclusive bounds (`min` for values the stored settings would not keep). Rejects empty,
 * unreadable, zero, negative and non-finite input with a short message.
 */
export function parsePositive(
  text: string,
  options: { integer?: boolean; min?: number; max: number; what: string },
): NumberParse {
  const t = text.trim().replace(',', '.')
  if (t === '') return { ok: false, error: msg('Enter {0}.', options.what) }
  if (!/^\d*\.?\d+$|^\d+\.$/u.test(t)) return { ok: false, error: msg('"{0}" is not a number.', text.trim()) }
  const value = Number(t)
  if (!Number.isFinite(value)) return { ok: false, error: msg('Enter a finite number.') }
  if (value <= 0) return { ok: false, error: msg('{0} must be greater than zero.', capitalize(options.what)) }
  if (options.integer && !Number.isInteger(value)) return { ok: false, error: msg('Use a whole number.') }
  if (options.min !== undefined && value < options.min)
    return { ok: false, error: msg('{0} must be at least {1}.', capitalize(options.what), options.min) }
  if (value > options.max)
    return { ok: false, error: msg('{0} can be at most {1}.', capitalize(options.what), options.max) }
  return { ok: true, value }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
