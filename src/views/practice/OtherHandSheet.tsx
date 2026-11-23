import { msg } from '../../i18n/messages'
/**
 * "Where should the left hand sound?" (DECISIONS U149): what Start asks when one hand is chosen and
 * the app cannot yet grade while it plays the other (P2). On the piano plays the test notes and
 * starts on Yes; On this device starts at once. Every start is inside its tap (iPadOS audio).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { OtherHandSound } from '../../app/session'
import { settings, updateSettings } from '../../app/state'
import type { EchoTestResult } from '../../core/midi/echo'
import { Button, Sheet } from '../../ui/controls'
import styles from './practice.module.css'

interface OtherHandProps {
  /** Where the other hand can sound. */
  readonly sound: OtherHandSound
  /** The hand the app will play. */
  readonly hand: 'left' | 'right'
  readonly testNotes: () => Promise<EchoTestResult | null>
  /** Verified and without an echo: start. */
  readonly onPiano: () => void
  readonly onDevice: () => void
  readonly onHelp: () => void
  readonly onClose: () => void
}

export function OtherHandSheet({ open, ...props }: OtherHandProps & { readonly open: boolean }) {
  const title =
    props.hand === 'left' ? msg('Where should the left hand sound?') : msg('Where should the right hand sound?')
  return (
    <Sheet title={title} open={open} onClose={props.onClose} floating>
      <OtherHand {...props} />
    </Sheet>
  )
}

type Step = 'choose' | 'listening' | 'heard' | 'silent' | 'echo' | 'unsure'

function OtherHand({ sound: now, hand, testNotes, onPiano, onDevice, onHelp, onClose }: OtherHandProps) {
  // As it was when the question opened: the sheet still shows it while it fades away.
  const [sound] = useState(now)
  const [step, setStep] = useState<Step>('choose')
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const play = async () => {
    setStep('listening')
    const result = await testNotes().catch(() => null)
    if (!mounted.current) return
    setStep(
      !result
        ? 'silent'
        : result.verdict === 'echo-detected'
          ? 'echo'
          : result.verdict === 'inconclusive'
            ? 'unsure'
            : 'heard',
    )
  }
  const answer = (heard: boolean) => {
    // The piano plays only with a destination that may use it (S4).
    if (heard && settings.peek().sound.destination === 'browser') updateSettings({ sound: { destination: 'auto' } })
    updateSettings({ route: { outputVerified: heard } })
    if (heard) onPiano()
    else setStep('silent')
  }

  const text: Readonly<Record<Step, string>> = {
    choose:
      hand === 'left'
        ? msg('You play the right hand. The app plays the left.')
        : msg('You play the left hand. The app plays the right.'),
    listening: msg('Keep your hands off the keys for a moment.'),
    heard: msg('Did the piano play three short notes?'),
    silent: msg('Check that the piano is on, connected and turned up, then try again.'),
    echo: msg('The piano sends back what the app plays, so the app cannot tell your hand from its own.'),
    unsure: msg(
      'The app could not tell whether the piano sends back what it plays. Keep your hands off the keys and try again.',
    ),
  }
  const device = sound.device ? <Button onClick={onDevice}>{msg('On this device')}</Button> : null
  const again = <Button onClick={() => void play()}>{msg('Try again')}</Button>
  const help = <Button onClick={onHelp}>{msg('More help')}</Button>
  return (
    <div class={styles.otherHand}>
      <p aria-live="polite">{text[step]}</p>
      <div class={styles.otherHandActions}>
        {step === 'choose' ? (
          <>
            {sound.piano ? <Button onClick={() => void play()}>{msg('On the piano')}</Button> : null}
            {device}
            <Button variant="ghost" onClick={onClose}>
              {msg('Cancel')}
            </Button>
          </>
        ) : step === 'heard' ? (
          <>
            <Button variant="primary" onClick={() => answer(true)}>
              {msg('Yes')}
            </Button>
            <Button onClick={() => answer(false)}>{msg('No')}</Button>
          </>
        ) : step === 'listening' ? (
          <Button variant="ghost" onClick={onClose}>
            {msg('Cancel')}
          </Button>
        ) : (
          <>
            {step === 'echo' ? null : again}
            {device}
            {help}
          </>
        )}
      </div>
    </div>
  )
}
