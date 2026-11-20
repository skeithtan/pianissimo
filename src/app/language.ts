import { effect, signal } from '@preact/signals'
import { closestLanguage, type Language } from '../core/model/language'
import { readMessagesWith, type Messages } from '../i18n/messages'
import { settings } from './state'

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

export function startLanguageSync(): () => void {
  readMessagesWith(() => messages.value)
  const deviceLanguage = () => closestLanguage(navigator.languages?.length ? navigator.languages : [navigator.language])
  const device = signal(deviceLanguage())
  const onChange = () => {
    device.value = deviceLanguage()
  }
  window.addEventListener('languagechange', onChange)
  let requested: Language | undefined
  const stop = effect(() => {
    const preference = settings.value.view.language
    const language = preference === 'system' ? device.value : preference
    if (requested === language) return
    requested = language
    const apply = (strings: Messages['strings']) => {
      if (requested !== language) return
      document.documentElement.lang = language
      messages.value = { language, strings }
    }
    if (language === 'en-US') apply({})
    else
      void loadStrings(language)
        .then(apply)
        .catch(() => {
          if (requested !== language) return
          document.documentElement.lang = 'en-US'
          messages.value = { language: 'en-US', strings: {} }
          requested = undefined
        })
  })
  return () => {
    stop()
    requested = undefined
    window.removeEventListener('languagechange', onChange)
  }
}
