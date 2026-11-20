/** General: suggested practice and theme. */
import { LANGUAGES, type LanguagePreference } from '../../core/model/language'
import { msg } from '../../i18n/messages'
import styles from './settings.module.css'
import { flushSettings, settings, updateSettings } from '../../app/state'
import { Segmented, Toggle } from '../../ui/controls'
import { Group, Setting } from './parts'

export function GeneralSection() {
  const { suggestions, view } = settings.value
  return (
    <>
      <Group>
        <label class={styles.language}>
          {msg('Language')}
          <select
            value={view.language}
            onChange={(event) => {
              updateSettings({ view: { language: event.currentTarget.value as LanguagePreference } })
              void flushSettings()
            }}
          >
            <option value="system">{msg('Use device language')}</option>
            {Object.entries(LANGUAGES).map(([tag, name]) => (
              <option key={tag} value={tag} lang={tag}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </Group>
      <Group title={msg('Suggested practice')}>
        <Toggle
          label={msg('Suggest passages to practice')}
          description={msg(
            'Offers bars that keep going wrong, in the Library and in results. Suggestions never interrupt a performance.',
          )}
          checked={suggestions.enabled}
          onChange={(enabled) => updateSettings({ suggestions: { enabled } })}
        />
      </Group>
      <Group title={msg('Display')}>
        <Setting label={msg('Theme')} description={msg("System follows the device's light or dark setting.")}>
          <Segmented
            label={msg('Theme')}
            value={view.theme}
            options={[
              { value: 'system', label: msg('System') },
              { value: 'light', label: msg('Light') },
              { value: 'dark', label: msg('Dark') },
            ]}
            onChange={(theme) => updateSettings({ view: { theme } })}
          />
        </Setting>
        <Setting
          label={msg('Score paper')}
          description={msg(
            'Match theme gives the score dark paper with light notes in dark mode. Always light keeps classic printed-page colors.',
          )}
        >
          <Segmented
            label={msg('Score paper')}
            value={view.scorePaper}
            options={[
              { value: 'theme', label: msg('Match theme') },
              { value: 'light', label: msg('Always light') },
            ]}
            onChange={(scorePaper) => updateSettings({ view: { scorePaper } })}
          />
        </Setting>
      </Group>
    </>
  )
}
