/** Lightweight score placeholders while engraving loads. No notation or layout work (U62). */
import type { ScoreViewMode } from './env'
import styles from './scoreSkeleton.module.css'

const HEIGHTS = [24, 12, 18, 6, 24, 30, 18, 12]

export function ScoreSkeleton({ mode, fraction }: { mode: ScoreViewMode; fraction: number }) {
  return (
    <div class={styles.root} data-mode={mode} data-testid="score-skeleton">
      <div class={styles.systems} aria-hidden="true">
        {Array.from({ length: mode === 'page' ? 3 : 1 }, (_, system) => (
          <div class={styles.system} key={system}>
            {[0, 1].map((staff) => (
              <div class={styles.staff} key={staff}>
                <span class={styles.signature} />
                {HEIGHTS.map((top, note) => (
                  <span
                    class={styles.note}
                    key={note}
                    style={{ left: `${15 + note * 10.5}%`, top: `${staff ? 36 - top : top}px` }}
                  />
                ))}
              </div>
            ))}
            <span class={styles.bar} style={{ left: '39%' }} />
            <span class={styles.bar} style={{ left: '72%' }} />
          </div>
        ))}
      </div>
      <div class={styles.status} role="status">
        Preparing the score… {fraction > 0 ? `${Math.round(fraction * 100)}%` : ''}
      </div>
    </div>
  )
}
