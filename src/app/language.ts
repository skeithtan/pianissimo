/**
 * The interface language. The setting (`view.language`, "system" by default) resolves to a
 * catalog, which loads as its own chunk; `<html lang>` and the message reader change together.
 * The last resolved language is cached in localStorage (a per-device convenience, like the theme)
 * so a returning player's catalog starts loading before the first render, and nothing acts on the
 * default setting while stored settings load.
 */
import { computed, effect, signal } from '@preact/signals'
import { LANGUAGES, closestLanguage, type Language } from '../core/model/language'
import { msg, readMessagesWith, type Messages } from '../i18n/messages'
import { pushNotice, settings, settingsLoading } from './state'

const CACHE_KEY = 'pianissimo.language'

const messages = signal<Messages>({ language: 'en-US', strings: {} })
const catalogs = {
  'es-ES': () => import('../i18n/locales/es-ES.json').then((m) => m.default),
  'fr-FR': () => import('../i18n/locales/fr-FR.json').then((m) => m.default),
  'fr-CA': async () => {
    const [base, regional] = await Promise.all([catalogs['fr-FR'](), import('../i18n/locales/fr-CA.json')])
    return { ...base, ...regional.default }
  },
  'ja-JP': () => import('../i18n/locales/ja-JP.json').then((m) => m.default),
  'fil-PH': () => import('../i18n/locales/fil-PH.json').then((m) => m.default),
}

async function loadStrings(language: Exclude<Language, 'en-US'>): Promise<Messages['strings']> {
  const [english, translated] = await Promise.all([import('../i18n/locales/en-US.json'), catalogs[language]()])
  const source: Messages['strings'] = english.default
  return Object.fromEntries(Object.entries(translated).map(([id, value]) => [source[id], value]))
}

function readCachedLanguage(): Language | null {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return value !== null && Object.hasOwn(LANGUAGES, value) ? (value as Language) : null
  } catch {
    return null
  }
}

function cacheLanguage(language: Language): void {
  try {
    localStorage.setItem(CACHE_KEY, language)
  } catch {
    // Private windows and blocked storage: the setting itself still persists through storage.
  }
}

/** Settles once the cached language's catalog, requested at start-up, has loaded or failed. */
let startup: Promise<void> | null = null

/**
 * Wait, at most `timeoutMs`, for the cached language's catalog so the first render is already in
 * that language. Null when no catalog is loading.
 */
export function languageReady(timeoutMs: number): Promise<void> | null {
  if (!startup) return null
  return Promise.race([startup, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])
}

export interface LanguageSyncOptions {
  /** Loads a catalog keyed by English source (tests inject a fake). */
  readonly load?: (language: Exclude<Language, 'en-US'>) => Promise<Messages['strings']>
  readonly root?: HTMLElement
}

export function startLanguageSync({
  load = loadStrings,
  root = document.documentElement,
}: LanguageSyncOptions = {}): () => void {
  readMessagesWith(() => messages.value)
  const deviceLanguage = () => closestLanguage(navigator.languages?.length ? navigator.languages : [navigator.language])
  const device = signal(deviceLanguage())
  const preference = computed(() => settings.value.view.language)
  /** The language on screen or being loaded. */
  let requested: Language | undefined

  const apply = (language: Language, strings: Messages['strings']) => {
    root.lang = language
    messages.value = { language, strings }
    cacheLanguage(language)
  }
  const request = (language: Language): Promise<void> | null => {
    if (requested === language) return null
    requested = language
    if (language === 'en-US') {
      apply(language, {})
      return null
    }
    return load(language).then(
      (strings) => {
        if (requested === language) apply(language, strings)
      },
      () => {
        if (requested !== language) return
        // Keep the language on screen; a language change or reconnecting tries again.
        requested = messages.peek().language
        pushNotice({
          kind: 'warning',
          text: msg(
            'The interface language could not be loaded, so the current language stays. It is tried again when you are back online or choose a language.',
          ),
        })
      },
    )
  }
  const sync = () => {
    const chosen = preference.value
    const language = chosen === 'system' ? device.value : chosen
    // Until stored settings arrive the setting is only the default: showing the device language
    // could override an explicit choice, so only the cached language (requested below) is shown.
    if (settingsLoading.value) return
    request(language)
  }

  const cached = readCachedLanguage()
  if (cached) startup = request(cached)
  const onLanguageChange = () => {
    device.value = deviceLanguage()
  }
  window.addEventListener('languagechange', onLanguageChange)
  window.addEventListener('online', sync)
  const stop = effect(sync)
  return () => {
    stop()
    startup = null
    requested = undefined
    messages.value = { language: 'en-US', strings: {} }
    window.removeEventListener('languagechange', onLanguageChange)
    window.removeEventListener('online', sync)
  }
}
