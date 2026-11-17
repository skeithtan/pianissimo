/**
 * Suggested practice for one piece in the Library (spec "Suggested practice"): the shared
 * `SuggestionList` (also used by Results) over `PieceSuggestionsModel`, which does loading,
 * session dismissal, the per-piece switch and "Practice this passage".
 *
 * No notation preview (spec mentions a small one): it needs the notation engine, which the
 * Library must not load (spec "Deferred assets"; DECISIONS L4). Bars, hand, speed, evidence and
 * progress are shown in words, with context bars distinguished from the difficult ones.
 */
import { useState } from 'preact/hooks'
import { openSettings } from '../../app/navigation'
import { Button } from '../../ui/controls'
import { SuggestionList } from '../shared/suggestions'
import type { PieceSuggestionsModel } from './suggestionsData'
import styles from './PieceCard.module.css'

export function PieceSuggestions({ model }: { model: PieceSuggestionsModel }) {
  const state = model.state.value
  if (state.status !== 'ready' || state.globallyDisabled || state.selection.disabled) return null
  const { selection } = state
  if (selection.active.length === 0 && selection.improved.length === 0) return null
  return (
    <div class={styles.suggestions}>
      <SuggestionList
        compact
        headingLevel={3}
        showHeading={false}
        hideEmpty
        suggestions={selection.active}
        improved={selection.improved}
        onPractice={(s) => void model.practice(s)}
        onDismiss={(s) => model.dismiss(s.id)}
      />
    </div>
  )
}

/** Preferences are available even when there are no suggestions to show. */
export function SuggestionOptions({ model, onClose }: { model: PieceSuggestionsModel; onClose: () => void }) {
  const state = model.state.value
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state.status === 'loading') return <p>Loading suggestion preferences…</p>
  if (state.status === 'error') {
    return (
      <Button variant="ghost" onClick={() => void model.load()}>
        Retry loading suggestions
      </Button>
    )
  }
  if (state.globallyDisabled) {
    return (
      <Button
        variant="ghost"
        onClick={() => {
          onClose()
          openSettings()
        }}
      >
        Suggestions are turned off in Settings
      </Button>
    )
  }
  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await model.setDisabled(!state.selection.disabled)
      onClose()
    } catch {
      setError('The suggestion preference could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="ghost" disabled={busy} onClick={() => void toggle()}>
        {state.selection.disabled ? 'Turn on suggestions for this piece' : 'Turn off suggestions for this piece'}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  )
}
