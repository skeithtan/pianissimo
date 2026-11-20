export const LANGUAGES = {
  'en-US': 'English (United States)',
  'es-ES': 'Español (España)',
  'fr-CA': 'Français (Canada)',
  'fr-FR': 'Français (France)',
  'fil-PH': 'Filipino',
  'ja-JP': '日本語',
} as const

export type Language = keyof typeof LANGUAGES
export type LanguagePreference = Language | 'system'

/** Walk the device's ordered preferences, accepting regional variants and Tagalog. */
export function closestLanguage(preferences: readonly string[]): Language {
  for (const tag of preferences) {
    try {
      const { language, region } = new Intl.Locale(tag)
      if (language === 'en') return 'en-US'
      if (language === 'ja') return 'ja-JP'
      if (language === 'es') return 'es-ES'
      if (language === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR'
      if (language === 'fil' || language === 'tl') return 'fil-PH'
    } catch {
      // Skip an invalid tag and continue with the next device preference.
    }
  }
  return 'en-US'
}
