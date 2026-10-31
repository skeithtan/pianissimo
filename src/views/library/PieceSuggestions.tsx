/**
 * Suggested practice for one piece in the Library (spec "Suggested practice"): the shared
 * `SuggestionList` (also used by Results) over `PieceSuggestionsModel`, which does loading,
 * session dismissal, the per-piece switch and "Practice this passage".
 *
 * No notation preview (spec mentions a small one): it needs the notation engine, which the
 * Library must not load (spec "Deferred assets"; DECISIONS L4). Bars, hand, speed, evidence and
 * progress are shown in words, with context bars distinguished from the difficult ones.
 */
import { useEffect, useMemo } from 'preact/hooks'
import { openSettings } from '../../app/navigation'
import { Button } from '../../ui/controls'
import { SuggestionList } from '../shared/suggestions'
import { PieceSuggestionsModel, type SuggestionsDeps } from './suggestionsData'
import styles from './library.module.css'

export function PieceSuggestions({ pieceId, deps }: { pieceId: string; deps: SuggestionsDeps }) {
  const model = useMemo(() => new PieceSuggestionsModel(deps, pieceId), [pieceId])
  useEffect(() => {
    void model.start()
    return () => model.dispose()
  }, [model])
  const state = model.state.value

  if (state.status === 'loading') return <p class={styles.muted}>Looking at your recent practice…</p>
  if (state.status === 'error') return <p class={styles.muted}>{state.message}</p>
  if (state.globallyDisabled) {
    return (
      <div class={styles.suggestionActions}>
        <p class={styles.muted}>Suggestions are turned off in Settings.</p>
        <Button variant="ghost" onClick={openSettings}>
          Open Settings
        </Button>
      </div>
    )
  }
  const { selection } = state
  return (
    <SuggestionList
      compact
      headingLevel={3}
      suggestions={selection.active}
      improved={selection.improved}
      disabled={selection.disabled}
      onPractice={(s) => void model.practice(s)}
      onDismiss={(s) => model.dismiss(s.id)}
      onDisableSuggestions={() => void model.setDisabled(true)}
      onEnableSuggestions={() => void model.setDisabled(false)}
      disableLabel="Turn off suggestions for this piece"
    />
  )
}
