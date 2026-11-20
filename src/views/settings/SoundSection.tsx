import { msg } from '../../i18n/messages'
/**
 * Sound (spec "Listening and hand practice", DECISIONS S4): where Listen and the accompaniment
 * play. Auto (default) uses the connected piano when there is one and this device otherwise;
 * Connected piano and Browser sound pin one destination. Also the browser volume, the
 * accompaniment level and the metronome: "Metronome click" (Listen, reading, scored practice and
 * Play through) and "Click in Keep time" (the rhythm mode's attempt), each its own switch (DECISIONS
 * P20; the Practice and Study menus edit the one that applies, U87), and one shared volume.
 */
import { settings, updateSettings } from '../../app/state'
import type { FeatureReport } from '../../app/features'
import type { SoundDestination } from '../../core/model/settings'
import { Notice, Segmented, Slider, Toggle } from '../../ui/controls'
import { Group, Help, Setting } from './parts'
import { MetronomeOutputSettings } from './MetronomeOutputSettings'

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
      return msg(
        "The connected piano plays when there is one. Otherwise sound comes from this device's speakers. {0}",
        msg(SAMPLES),
      )
    case 'midi':
      return msg(
        'Only the piano plays. Without a connected piano that can receive notes from the app, playback is unavailable. It is never switched to browser sound.',
      )
    case 'browser':
      return msg("Sound always comes from this device's speakers, even with a piano connected. {0}", msg(SAMPLES))
  }
}

export function SoundSection({ features }: { features: FeatureReport }) {
  const { sound, metronome, route, mic } = settings.value
  const audio = features.features.webAudio
  return (
    <>
      <Group>
        <Setting label={msg('Sound destination')} description={msg('Where Listen and the accompaniment play.')}>
          <Segmented<SoundDestination>
            label={msg('Sound destination')}
            value={sound.destination}
            options={DESTINATIONS.map((o) => ({ ...o, label: msg(o.label) }))}
            onChange={(destination) => updateSettings({ sound: { destination } })}
          />
        </Setting>
        <Help>{destinationHelp(sound.destination)}</Help>
        {sound.destination === 'browser' && !audio.supported && audio.explanation ? (
          <Notice tone="warning">{audio.explanation}</Notice>
        ) : null}
        <Slider
          label={msg('Browser sound volume')}
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
          label={msg('Accompaniment level')}
          min={0}
          max={1}
          step={0.05}
          value={route.accompanimentLevel}
          format={percent}
          onChange={(accompanimentLevel) => updateSettings({ route: { accompanimentLevel } })}
        />
        <Help>{msg('Changes only what the app plays (the part you are not playing), never your own keys.')}</Help>
      </Group>

      <Group title={msg('Metronome')}>
        <Toggle
          label={msg('Metronome click')}
          description={msg(
            'Off by default. In Listen, reading and Play through it follows the music and never forces the score to advance.',
          )}
          checked={metronome.enabled}
          onChange={(enabled) => updateSettings({ metronome: { enabled } })}
        />
        <Toggle
          label={msg('Click in Keep time')}
          description={msg(
            'On by default. In Keep time the beat keeps clicking through the attempt, after the count-in.',
          )}
          checked={metronome.keepTime}
          onChange={(keepTime) => updateSettings({ metronome: { keepTime } })}
        />
        <Slider
          label={msg('Metronome volume')}
          min={0}
          max={1}
          step={0.05}
          value={metronome.volume}
          format={percent}
          disabled={!metronome.enabled && !metronome.keepTime}
          onChange={(volume) => updateSettings({ metronome: { volume } })}
        />
        {audio.supported ? <MetronomeOutputSettings /> : null}
        {metronome.enabled && !audio.supported && audio.explanation ? (
          <Notice tone="warning">{audio.explanation}</Notice>
        ) : null}
      </Group>

      <Group title={msg('Silent controllers')}>
        <Toggle
          label={msg('Hear my keys through browser sound')}
          description={msg('For keyboards that make no sound of their own. Off by default.')}
          checked={sound.monitorInput}
          onChange={(monitorInput) => updateSettings({ sound: { monitorInput } })}
        />
      </Group>

      <Group title={msg('Microphone')}>
        <Toggle
          label={msg('Follow the microphone with a piano connected')}
          description={msg(
            "Without a piano, Play through always follows the microphone. With one, it follows the piano's keys unless this is on. Same as Follow in the Practice menu.",
          )}
          checked={mic.follow}
          onChange={(follow) => updateSettings({ mic: { follow } })}
        />
        <Help>
          {msg(
            'Position only: wrong notes are not judged, and the microphone is closed outside Play through. The browser asks for it on the first Start. The cursor waits as long as you do and moves when it hears the next notes, at any speed. Keep the device near the piano. While the microphone follows, Pianissimo plays nothing: no other hand, no metronome.',
          )}
        </Help>
      </Group>
    </>
  )
}
