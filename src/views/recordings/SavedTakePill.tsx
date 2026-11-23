import type { RefObject } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { msg, percentage } from '../../i18n/messages'
import { pushNotice } from '../../app/state'
import { noteAccuracy } from '../../core/recording/performance'
import type { RecordingInfo } from '../../core/recording/records'
import { Icon } from '../../ui/icons'
import pill from '../../ui/statusPill.module.css'
import control from './recordingControl.module.css'
import type { SavedTake } from './unsaved'

/** What the pill says, in one line (assistive technology hears it when the take is saved). */
export function savedTakeText(info: RecordingInfo): string {
  return [msg('Take saved'), info.interrupted && msg('Interrupted'), percentage(noteAccuracy(info.score))]
    .filter(Boolean)
    .join(' · ')
}

/** Plays a take's audio. The URL lives from the first Listen until `release`. */
class TakePlayer {
  #audio: HTMLAudioElement | null = null
  #url = ''

  constructor(
    private readonly blob: Blob,
    private readonly onPlaying: (playing: boolean) => void,
    private readonly onFailed: () => void,
  ) {}

  toggle(): void {
    const audio = (this.#audio ??= this.#open())
    if (!audio.paused) audio.pause()
    else
      audio.play().catch((error: unknown) => {
        // A pause (or the pill going) before playback began is not a failure.
        if ((error as { name?: unknown } | null)?.name !== 'AbortError' && this.#audio) this.onFailed()
      })
  }

  pause(): void {
    this.#audio?.pause()
  }

  release(): void {
    const audio = this.#audio
    this.#audio = null
    if (!audio) return
    audio.onplay = audio.onpause = audio.onended = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    URL.revokeObjectURL(this.#url)
  }

  #open(): HTMLAudioElement {
    this.#url = URL.createObjectURL(this.blob)
    const audio = new Audio(this.#url)
    audio.onplay = () => this.onPlaying(true)
    audio.onpause = audio.onended = () => this.onPlaying(false)
    return audio
  }
}

/** Four letters and the ellipsis, about two more wide: shortened further, the words give way entirely. */
const MIN_WORD_CHARS = 6

/**
 * Hides the pill's words where they would be shortened to a few characters (a narrow header with a long
 * title), and shows them again once there is room. Measured with the words shown, when the pill's
 * surroundings change size, never on a render. Hidden, they are only narrowed to nothing: `useModeFit`
 * still measures them in full.
 */
function useWordsRoom(words: RefObject<HTMLElement | null>, host: HTMLElement | null, text: string): void {
  useLayoutEffect(() => {
    const el = words.current
    const around = host?.closest('[data-recording-control]')?.parentElement ?? host?.parentElement
    if (!el || !around || typeof ResizeObserver === 'undefined') return
    const check = () => {
      el.removeAttribute('data-hidden')
      const full = el.scrollWidth
      if (full > el.clientWidth && el.clientWidth < (full / text.length) * MIN_WORD_CHARS)
        el.setAttribute('data-hidden', '')
    }
    const resize = new ResizeObserver(check)
    resize.observe(around)
    for (const part of Array.from(around.children)) if (!part.contains(host)) resize.observe(part)
    check()
    return () => resize.disconnect()
  }, [host, text])
}

/**
 * The pill after Stop (DECISIONS D20), in the place the timer and Stop had: the take's note score,
 * Listen, Recordings at this take, and Close. It is drawn into `host`, which changes when a phone
 * turns; the player does not.
 */
export function SavedTakePill({
  take,
  host,
  listOpen,
  covered,
  takeFocus,
  onRecordings,
  onClose,
}: {
  take: SavedTake
  host: HTMLElement | null
  /** The Recordings list, with its own player, is open over the score. */
  listOpen: boolean
  /** Progress, with players of its own, is open over the score. */
  covered: boolean
  /** Stop had the keyboard's focus: Listen gets it. */
  takeFocus: boolean
  onRecordings: () => void
  onClose: () => void
}) {
  const [playing, setPlaying] = useState(false)
  const player = useRef<TakePlayer | null>(null)
  const listen = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLButtonElement>(null)
  const words = useRef<HTMLSpanElement>(null)
  const listWasOpen = useRef(false)
  // A layout effect: its cleanup, and with it the silence, comes as the pill goes, not a paint later.
  useLayoutEffect(() => {
    const own = new TakePlayer(take.files.audio, setPlaying, () =>
      pushNotice({ kind: 'warning', text: msg('Could not open this recording.') }),
    )
    player.current = own
    setPlaying(false)
    return () => {
      player.current = null
      own.release()
    }
  }, [take])
  useEffect(() => {
    // The list closed: focus returns to the button that opened it.
    if (!listOpen && listWasOpen.current) list.current?.focus()
    listWasOpen.current = listOpen
  }, [listOpen])
  useEffect(() => {
    if (listOpen || covered) player.current?.pause()
  }, [listOpen, covered])
  useEffect(() => {
    if (takeFocus) listen.current?.focus()
  }, [])
  const { interrupted, score } = take.info
  const text = interrupted ? msg('Interrupted') : msg('Take saved')
  useWordsRoom(words, host, text)
  if (!host) return null
  return createPortal(
    <span
      class={`${pill.pill} ${control.saved}`}
      role="group"
      aria-label={msg('Take saved')}
      data-interrupted={interrupted || undefined}
    >
      <span class={control.text}>
        <Icon name={interrupted ? 'alert' : 'check'} size={16} />
        <span ref={words} class={control.words}>
          {text}
        </span>
        <span class={control.score}>{percentage(noteAccuracy(score))}</span>
      </span>
      <button
        ref={listen}
        type="button"
        class={`${pill.action} ${control.icon}`}
        aria-label={playing ? msg('Pause') : msg('Listen to recording')}
        title={playing ? msg('Pause') : msg('Listen to recording')}
        onClick={() => player.current?.toggle()}
      >
        <Icon name={playing ? 'pause' : 'play'} size={17} />
      </button>
      <button
        ref={list}
        type="button"
        class={`${pill.action} ${control.icon}`}
        aria-label={msg('Recordings')}
        title={msg('Recordings')}
        onClick={onRecordings}
      >
        <Icon name="list" size={18} />
      </button>
      <button
        type="button"
        class={`${pill.action} ${control.icon}`}
        aria-label={msg('Close')}
        title={msg('Close')}
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
    </span>,
    host,
  )
}
