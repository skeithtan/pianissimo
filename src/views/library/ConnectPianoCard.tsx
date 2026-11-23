import { msg } from '../../i18n/messages'
/**
 * First-time piano setup in the Library (DECISIONS U149): one card while no piano is connected and
 * none is remembered. Connect asks for access and takes the only piano, lists several, or says
 * plainly what is missing; the first key ends it. The piano setup stays behind More help.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { getFeatures } from '../../app/features'
import { openConnection } from '../../app/navigation'
import { getMidiService, type MidiService } from '../../app/services'
import { settings, settingsLoading } from '../../app/state'
import { Button } from '../../ui/controls'
import styles from './LibraryPage.module.css'

/** How long "Your piano is ready." stays. */
const READY_MS = 2500

/** What the card says; `blocked`: no access (refused, or the browser failed). */
type Step = 'offer' | 'looking' | 'none' | 'several' | 'blocked' | 'check' | 'ready' | 'done'

/** Nothing without Web MIDI: the capability banner says so. */
export function ConnectPianoCard() {
  return getFeatures().features.webMidi.supported ? <ConnectPiano service={getMidiService()} /> : null
}

export function ConnectPiano({ service }: { service: MidiService }) {
  const [snap, setSnap] = useState(service.snapshot)
  const [step, setStep] = useState<Step>('offer')
  const mounted = useRef(true)
  useEffect(() => {
    setSnap(service.snapshot)
    const off = service.subscribe(setSnap)
    return () => {
      mounted.current = false
      off()
    }
  }, [service])

  const pianos = snap.inputs.filter((p) => p.state === 'connected')
  const connected = snap.input?.connected === true
  const look = async () => {
    setStep('looking')
    const granted = await service.connectOnBoot()
    if (!mounted.current) return
    const now = service.snapshot
    if (now.input?.connected) setStep('check')
    else if (!granted) setStep('blocked')
    else setStep(now.inputs.some((p) => p.state === 'connected') ? 'several' : 'none')
  }

  // A piano plugged in, or access given in the piano setup, answers the card where it is.
  useEffect(() => {
    if (step === 'several' && pianos.length === 0) setStep('none')
    if ((step === 'none' && pianos.length > 0) || (step === 'blocked' && snap.access === 'granted')) void look()
  }, [step, snap])

  useEffect(() => {
    if (step === 'check')
      return service.adapter.subscribe((ev) => {
        if (ev.kind === 'noteon') setStep('ready')
      })
    if (step !== 'ready') return
    const timer = setTimeout(() => setStep('done'), READY_MS)
    return () => clearTimeout(timer)
  }, [step, service])

  const remembered = settings.value.route.inputId !== null
  const show =
    step === 'check' || step === 'ready'
      ? connected
      : step === 'looking' ||
        (step !== 'done' && !settingsLoading.value && !remembered && !connected && snap.access !== 'requesting')

  const help = <Button onClick={openConnection}>{msg('More help')}</Button>
  const text: Readonly<Record<Step, string>> = {
    offer: msg('Or open any piece to listen and read.'),
    looking: msg('Or open any piece to listen and read.'),
    none: msg('No piano found. Plug it in over USB, or pair it over Bluetooth.'),
    several: msg('Choose your piano'),
    blocked:
      snap.access === 'error'
        ? msg('The browser could not look for a piano. Reload the page and try again.')
        : msg('The browser is blocking your piano. Allow it for this site in the browser’s settings.'),
    check: msg('Play any key to check it.'),
    ready: '',
    done: '',
  }
  return (
    // The live region stays in the page, so what appears in it is announced.
    <div class={styles.connectSlot} aria-live="polite">
      {show ? (
        <section class={styles.connect} data-testid="connect-piano" aria-labelledby="connect-piano">
          <div>
            <h2 id="connect-piano">{step === 'ready' ? msg('Your piano is ready.') : msg('Connect your piano')}</h2>
            {text[step] ? <p>{text[step]}</p> : null}
          </div>
          <div class={styles.connectActions}>
            {step === 'offer' || step === 'looking' ? (
              <Button variant="primary" icon="plug" disabled={step === 'looking'} onClick={() => void look()}>
                {step === 'looking' ? msg('Waiting for your answer…') : msg('Connect')}
              </Button>
            ) : step === 'none' ? (
              <>
                <Button onClick={() => void look()}>{msg('Try again')}</Button>
                {help}
              </>
            ) : step === 'several' ? (
              pianos.map((p) => (
                <Button
                  key={p.id}
                  onClick={() => {
                    if (service.selectPiano(p.id)) setStep('check')
                  }}
                >
                  {p.name}
                </Button>
              ))
            ) : step === 'blocked' ? (
              help
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}
