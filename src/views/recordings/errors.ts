import { RecordingError } from '../../app/audio/performanceInput'
import { msg } from '../../i18n/messages'

/** Browser errors from opening audio input, by `name`, in words for the player. */
const AUDIO_ERRORS: Readonly<Record<string, () => string>> = {
  NotAllowedError: () =>
    msg(
      'Pianissimo is not allowed to use audio input. Allow microphone access for this site in your browser settings, then try again.',
    ),
  NotFoundError: () => msg('No audio input was found. Connect the piano’s USB audio, then try again.'),
  OverconstrainedError: () => msg('The selected audio input is not available. Choose another input or reconnect it.'),
  NotReadableError: () =>
    msg('The audio input could not be started. Another app may be using it. Close that app, then try again.'),
}

/**
 * What the recorder shows for a failure to open audio input or start a take: our own messages
 * as they are, known browser errors in the interface language, and never a browser's raw text.
 */
export function recorderErrorText(error: unknown, when: 'open' | 'start'): string {
  if (error instanceof RecordingError) return error.message
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined
  const known = typeof name === 'string' && Object.hasOwn(AUDIO_ERRORS, name) ? AUDIO_ERRORS[name] : undefined
  if (known) return known()
  return when === 'open'
    ? msg('The audio input could not be opened. Try again.')
    : msg('The recording could not start. Try again.')
}
