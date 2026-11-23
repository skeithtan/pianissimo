import { msg, percentage } from '../../i18n/messages'
/**
 * The sound part of Settings → Piano and sound (spec "Listening and hand practice", DECISIONS S4).
 * Sound: where Listen and the accompaniment play. Auto (default) uses the connected piano when there
 * is one and this device otherwise; Connected piano and Browser sound pin one destination. Also the
 * browser volume, the accompaniment level and hearing a silent keyboard's keys. Metronome:
 * "Metronome click" (Listen, Wait and Follow) and "Click in Keep time" (the attempt after the
 * count-in), each its own switch (DECISIONS P20; the Practice menu edits the one that applies, U87),
 * and one shared volume. Recording: the remembered input of performance recordings (D20).
 */
import { settings, updateSettings } from '../../app/state'
import type { FeatureReport } from '../../app/features'
import type { SoundDestination } from '../../core/model/settings'
import { NO_RECORDING_INPUT, hasRememberedInput } from '../../core/recording/input'
import { Button, Notice, Segmented, Slider, Toggle } from '../../ui/controls'
import { MetronomeOutputSettings } from './MetronomeOutputSettings'
import { Group, Help, Setting } from './parts'

const percent = (v: number): string => percentage(Math.round(v * 100) / 100)

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
  const { sound, route } = settings.value
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

      <Group title={msg('Silent controllers')}>
        <Toggle
          label={msg('Hear my keys through browser sound')}
          description={msg('For keyboards that make no sound of their own. Off by default.')}
          checked={sound.monitorInput}
          onChange={(monitorInput) => updateSettings({ sound: { monitorInput } })}
        />
      </Group>
    </>
  )
}

export function MetronomeSection({ features }: { features: FeatureReport }) {
  const { metronome } = settings.value
  const audio = features.features.webAudio
  return (
    <Group>
      <Toggle
        label={msg('Metronome click')}
        description={msg(
          'Off by default. In Listen, Wait and Follow it follows the music and never forces the score to advance.',
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
  )
}

export function RecordingSection() {
  const { recording } = settings.value
  return (
    <Group>
      {hasRememberedInput(recording) ? (
        <Setting label={msg('Audio input')} description={recording.inputLabel ?? msg('System audio input')}>
          <Button onClick={() => updateSettings({ recording: NO_RECORDING_INPUT })}>{msg('Choose again')}</Button>
        </Setting>
      ) : (
        <Help>{msg('You choose the audio input the next time you record.')}</Help>
      )}
    </Group>
  )
}

export function MicrophoneSection() {
  const { mic } = settings.value
  return (
    <Group>
      <Toggle
        label={msg('Follow the microphone with a piano connected')}
        description={msg(
          "Without a piano, Follow always uses the microphone. With one, it follows the piano's keys unless this is on. Same as Follow input in the Practice menu.",
        )}
        checked={mic.follow}
        onChange={(follow) => updateSettings({ mic: { follow } })}
      />
      <Help>
        {msg(
          'Position only: wrong notes are not judged, and the microphone is closed outside Follow. The browser asks for it on the first Start. The cursor waits as long as you do and moves when it hears the next notes, at any speed. Keep the device near the piano. While the microphone follows, Pianissimo plays nothing: no other hand, no metronome.',
        )}
      </Help>
    </Group>
  )
}
