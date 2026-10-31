/**
 * Sound (spec "Listening and hand practice", DECISIONS S4): where Listen and the accompaniment
 * play. Auto (default) uses the connected piano when there is one and this device otherwise;
 * Connected piano and Browser sound pin one destination. Also the browser volume, the
 * accompaniment level and the metronome.
 */
import { settings, updateSettings } from '../../app/state'
import type { FeatureReport } from '../../app/features'
import type { SoundDestination } from '../../core/model/settings'
import { Notice, Segmented, Slider, Toggle } from '../../ui/controls'
import { Group, Help, Setting } from './parts'

const percent = (v: number): string => `${Math.round(v * 100)}%`

const DESTINATIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'midi', label: 'Connected piano (MIDI)' },
  { value: 'browser', label: 'Browser sound' },
] as const

const SAMPLES = 'The piano samples (about 2 MB) download the first time they are needed.'

function destinationHelp(destination: SoundDestination): string {
  switch (destination) {
    case 'auto':
      return `The connected piano plays when there is one; otherwise sound comes from this device's speakers. ${SAMPLES}`
    case 'midi':
      return 'Only the piano plays. Without a connected piano that can receive notes from the app, playback is unavailable; it is never switched to browser sound.'
    case 'browser':
      return `Sound always comes from this device's speakers, even with a piano connected. ${SAMPLES}`
  }
}

export function SoundSection({ features }: { features: FeatureReport }) {
  const { sound, metronome, route } = settings.value
  const audio = features.features.webAudio
  return (
    <>
      <Group>
        <Setting label="Sound destination" description="Where Listen and the accompaniment play.">
          <Segmented<SoundDestination>
            label="Sound destination"
            value={sound.destination}
            options={DESTINATIONS}
            onChange={(destination) => updateSettings({ sound: { destination } })}
          />
        </Setting>
        <Help>{destinationHelp(sound.destination)}</Help>
        {sound.destination === 'browser' && !audio.supported && audio.explanation ? (
          <Notice tone="warning">{audio.explanation}</Notice>
        ) : null}
        <Slider
          label="Browser sound volume"
          min={0}
          max={1}
          step={0.05}
          value={sound.browserVolume}
          format={percent}
          onChange={(browserVolume) => updateSettings({ sound: { browserVolume } })}
        />
      </Group>

      <Group>
        <Slider
          label="Accompaniment level"
          min={0}
          max={1}
          step={0.05}
          value={route.accompanimentLevel}
          format={percent}
          onChange={(accompanimentLevel) => updateSettings({ route: { accompanimentLevel } })}
        />
        <Help>Changes only what the app plays (the part you are not playing), never your own keys.</Help>
      </Group>

      <Group title="Metronome">
        <Toggle
          label="Metronome click"
          description="Off by default. It follows the music and never forces the score to advance."
          checked={metronome.enabled}
          onChange={(enabled) => updateSettings({ metronome: { enabled } })}
        />
        <Slider
          label="Metronome volume"
          min={0}
          max={1}
          step={0.05}
          value={metronome.volume}
          format={percent}
          disabled={!metronome.enabled}
          onChange={(volume) => updateSettings({ metronome: { volume } })}
        />
        {metronome.enabled && !audio.supported && audio.explanation ? (
          <Notice tone="warning">{audio.explanation}</Notice>
        ) : null}
      </Group>

      <Group title="Silent controllers">
        <Toggle
          label="Hear my keys through browser sound"
          description="For keyboards that make no sound of their own. Off by default."
          checked={sound.monitorInput}
          onChange={(monitorInput) => updateSettings({ sound: { monitorInput } })}
        />
      </Group>
    </>
  )
}
