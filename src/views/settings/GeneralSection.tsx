/** General: suggested practice and theme. */
import { settings, updateSettings } from '../../app/state'
import { Segmented, Toggle } from '../../ui/controls'
import { Group, Setting } from './parts'

export function GeneralSection() {
  const { suggestions, view } = settings.value
  return (
    <>
      <Group title="Suggested practice">
        <Toggle
          label="Suggest passages to practice"
          description="Offers bars that keep going wrong, in the Library and in results. Suggestions never interrupt a performance."
          checked={suggestions.enabled}
          onChange={(enabled) => updateSettings({ suggestions: { enabled } })}
        />
      </Group>
      <Group title="Display">
        <Setting label="Theme" description="System follows the device's light or dark setting.">
          <Segmented
            label="Theme"
            value={view.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(theme) => updateSettings({ view: { theme } })}
          />
        </Setting>
        <Setting
          label="Score paper"
          description="Match theme gives the score dark paper with light notes in dark mode. Always light keeps classic printed-page colors."
        >
          <Segmented
            label="Score paper"
            value={view.scorePaper}
            options={[
              { value: 'theme', label: 'Match theme' },
              { value: 'light', label: 'Always light' },
            ]}
            onChange={(scorePaper) => updateSettings({ view: { scorePaper } })}
          />
        </Setting>
      </Group>
    </>
  )
}
