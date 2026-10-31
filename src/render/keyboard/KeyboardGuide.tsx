import { useMemo, useRef } from 'preact/hooks'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import { describeGuide } from './describe'
import { KeyBars, KeyLabels, RollArrow } from './Highlights'
import { KeyLayer, Landmarks } from './Keys'
import { placeGuideLabels } from './labels'
import { buildLayout } from './layout'
import { PIANO, boardHeight, keysHeight } from './metrics'
import type { KeyboardGuideProps } from './types'
import { useElementWidth } from './useElementWidth'
import styles from './KeyboardGuide.module.css'

const FALLBACK_WIDTH = 640

/**
 * Spec "Keyboard rescue", redrawn per DECISIONS U15: the whole 88-key piano, top-down, in one
 * SVG. Each highlighted key — a target, a played target, a key the app is sounding (Listen, the
 * accompaniment), a held key, a wrong key — gets a translucent bar in its part's color and its
 * note name above it (naming settings apply; dense chords stack into lanes). There is no hand
 * letter. A marked roll shows as an arrow above the keys.
 *
 * Cheap to update on the iPad: the plain keys and landmarks are built once per width and passed
 * as the same elements on every update (Preact skips them), so an update only diffs the few
 * highlighted keys. The caller updates `keys` at most once per animation frame.
 *
 * Hiding fades the whole guide over `fadeMs` (spec "Apply the same opacity transition when
 * hiding the keyboard guide"); keep it mounted until the fade has finished.
 */
export function KeyboardGuide(props: KeyboardGuideProps) {
  const {
    keys,
    rollDirection,
    visible = true,
    fadeMs = DEFAULT_SETTINGS.hints.fadeMs,
    naming = DEFAULT_SETTINGS.naming,
  } = props

  const measureRef = useRef<HTMLDivElement>(null)
  const width = Math.max(1, useElementWidth(measureRef, FALLBACK_WIDTH))
  const layout = useMemo(() => buildLayout(PIANO, width), [width])
  const height = keysHeight(layout.whiteWidth)
  const whites = useMemo(() => <KeyLayer layout={layout} height={height} black={false} />, [layout, height])
  const blacks = useMemo(() => <KeyLayer layout={layout} height={height} black />, [layout, height])
  const landmarks = useMemo(
    () => <Landmarks layout={layout} height={height} naming={naming} />,
    [layout, height, naming],
  )
  const labels = useMemo(() => placeGuideLabels(keys, layout), [keys, layout])
  const label = useMemo(() => describeGuide(keys, rollDirection), [keys, rollDirection])
  const rollXs = useMemo(
    () => keys.filter((k) => k.state === 'target' || k.state === 'accepted').map((k) => layout.centerX(k.midi)),
    [keys, layout],
  )
  const board = boardHeight(layout.whiteWidth)
  const fade = `opacity ${fadeMs}ms ease`

  return (
    <div
      class={[styles.root, props.class].filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
      aria-hidden={visible ? undefined : 'true'}
      data-part="keyboard-guide"
      data-visible={visible ? 'true' : 'false'}
      style={{
        opacity: visible ? '1' : '0',
        visibility: visible ? 'visible' : 'hidden',
        transition: visible ? fade : `${fade}, visibility 0s linear ${fadeMs}ms`,
      }}
    >
      <div ref={measureRef} class={styles.measure}>
        <svg
          class={styles.board}
          data-part="board"
          width={width}
          height={board}
          viewBox={`0 0 ${width} ${board}`}
          aria-hidden="true"
          focusable="false"
        >
          {whites}
          <KeyBars layout={layout} keys={keys} height={height} black={false} />
          {blacks}
          <KeyBars layout={layout} keys={keys} height={height} black />
          {landmarks}
          {rollDirection ? <RollArrow xs={rollXs} direction={rollDirection} /> : null}
          <KeyLabels labels={labels} />
        </svg>
      </div>
    </div>
  )
}
