import type { ComponentType } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import styles from './recordingControl.module.css'
import { msg } from '../../i18n/messages'
import { connectionStatus, pushNotice, settings } from '../../app/state'
import type { RecordingSettings } from '../../core/model/settings'
import { hasRememberedInput } from '../../core/recording/input'
import type { TakeTarget } from './take'
import type { RecordingStorage } from './History'

/**
 * What the recorder is doing: its setup sheet, a one-tap take opening its input, the take, its
 * saving, the saved take's pill, or the Recordings list.
 */
export type TakePhase = 'setup' | 'opening' | 'recording' | 'saving' | 'saved' | 'list'

/** Start a take at once from the remembered input (DECISIONS D20). */
export interface OneTap {
  readonly input: RecordingSettings
  /** Started inside the tap: iPadOS starts an AudioContext only during a gesture. */
  readonly context: AudioContext | undefined
}

type PanelProps = {
  onClose: () => void
  onPhase: (phase: TakePhase) => void
  controlsHost: HTMLElement | null
  covered: boolean
}

/** The remembered input, when Record performance can use it at once: a piano must be connected. */
function oneTapTake(): OneTap | null {
  const input = settings.peek().recording
  if (!hasRememberedInput(input) || connectionStatus.peek().state !== 'connected') return null
  if (typeof AudioContext === 'undefined') return { input, context: undefined }
  const context = new AudioContext()
  void context.resume().catch(() => {})
  return { input, context }
}

/**
 * `playing`: the score plays. A saved take's pill goes when it starts. `covered`: Progress is open
 * over the score, and the pill plays nothing meanwhile.
 */
export function useRecordingDialog(playing = false, covered = false) {
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null)
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null)
  const [phase, setPhase] = useState<TakePhase | null>(null)
  const now = useRef<TakePhase | null>(null)
  const generation = useRef(0)
  // A layout effect: its cleanup runs as the screen goes, an effect's only after the next paint.
  useLayoutEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const enter = (next: TakePhase | null) => {
    now.current = next
    setPhase(next)
  }
  const close = () => {
    generation.current++
    setPanel(null)
    enter(null)
  }
  useEffect(() => {
    if (playing && now.current === 'saved') close()
  }, [playing])
  /** Record a take of `target`, or show the Recordings list without one. */
  async function open(storage: RecordingStorage, target?: TakeTarget) {
    if (now.current !== null && BUSY.has(now.current)) return
    const request = ++generation.current
    const oneTap = target ? oneTapTake() : null
    // The last take's pill goes when another starts.
    if (target) setPanel(null)
    enter(oneTap ? 'opening' : target ? 'setup' : 'list')
    try {
      if (target) {
        const { Recorder } = await import('./Recorder')
        if (request !== generation.current) {
          void oneTap?.context?.close().catch(() => {})
          return
        }
        setPanel(() => (panel: PanelProps) => <Recorder target={target} oneTap={oneTap} {...panel} />)
      } else {
        const { RecordingHistory } = await import('./History')
        if (request === generation.current)
          setPanel(() => ({ onClose }: PanelProps) => <RecordingHistory storage={storage} onClose={onClose} />)
      }
    } catch {
      void oneTap?.context?.close().catch(() => {})
      if (request === generation.current) enter(null)
      pushNotice({
        kind: 'warning',
        text: msg('This screen could not be loaded. Check your connection and try again.'),
      })
    }
  }
  /**
   * The header's place for a take: its busy state while the input opens, its status light, timer
   * and Stop, then the saved take's pill. Otherwise it renders nothing (no space, nothing to
   * focus); a take is started from the menus' Record performance button. On a portrait phone
   * (`inHeader` false) the take shows in `phoneFooter` instead.
   */
  function controls(_onOpen: () => void, inHeader = true) {
    if (!Panel || !inHeader) return null
    return (
      <div
        class={styles.control}
        data-recording-control
        data-words={phase === 'opening' || phase === 'saved' ? '' : undefined}
      >
        <span class={styles.slot} ref={setControlsHost} />
      </div>
    )
  }
  const busy = phase !== null && BUSY.has(phase)
  return {
    open,
    controls,
    phoneFooter: Panel ? <footer class={styles.phoneFooter} ref={setControlsHost} /> : null,
    dialog: Panel ? <Panel onClose={close} onPhase={enter} controlsHost={controlsHost} covered={covered} /> : null,
    /** A take is opening, recording or saving: no other can start. */
    busy,
    /** A take or the last one's pill holds the place `controls` (or `phoneFooter`) gives it. */
    showing: busy || phase === 'saved',
    /** The recorder has the learner's attention (the menu that opened it closes): all but the pill. */
    isOpen: phase !== null && phase !== 'saved',
  }
}

const BUSY: ReadonlySet<TakePhase> = new Set(['opening', 'recording', 'saving'])
