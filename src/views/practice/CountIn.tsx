/**
 * The Keep time count-in (rhythm mode, DECISIONS P13): the beats left, large and centered over the
 * stage while the session counts in (`ui.countIn`). Inside the stage only, so it never covers the
 * hand toggles or the main button; pointer events pass through to the score. Each beat pops in
 * gently, without motion under `prefers-reduced-motion`.
 */
import styles from './practice.module.css'

export function CountIn({ beats }: { readonly beats: number | null }) {
  if (beats === null) return null
  return (
    <div class={styles.countIn} role="status" aria-label={`Count-in: ${beats}`} data-testid="count-in">
      {/* A new element per beat restarts the pop. */}
      <span key={beats} class={styles.countInBeat} aria-hidden="true">
        {beats}
      </span>
    </div>
  )
}
