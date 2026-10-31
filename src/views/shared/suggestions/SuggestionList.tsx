/**
 * Suggested practice (spec "Suggested practice"): up to three suggestions with their affected
 * bars, context bars kept visibly apart, hand and speed, specific evidence, recovery progress,
 * and an Improved list. Presentational: it fetches nothing and starts nothing. "Practice this
 * passage" and the other actions are callbacks, so the Library and Results decide what they do
 * (open Practice with the range, hands and speed preselected, never auto-start).
 */
import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'
import type { Suggestion } from '../../../core/history'
import { Button } from '../../../ui/controls'
import { Icon } from '../../../ui/icons'
import { barSpeech, barsTitle, difficultTitle, handsText, kindText, speedText } from './format'
import styles from './suggestions.module.css'

export type HeadingLevel = 2 | 3 | 4

export interface SuggestionListProps {
  /** Active suggestions, already ranked and capped at three by `selectSuggestions`. */
  readonly suggestions: readonly Suggestion[]
  /** Resolved suggestions, newest first. */
  readonly improved?: readonly Suggestion[]
  /** Suggestions are switched off (globally or for this piece): show that instead of the list. */
  readonly disabled?: boolean
  /** Tighter cards for the Library's per-piece section. */
  readonly compact?: boolean
  /** Heading element level for "Suggested practice" (default 2); cards use one level lower. */
  readonly headingLevel?: HeadingLevel
  /** Section title (default "Suggested practice"). */
  readonly title?: string
  /** "Practice this passage": open Practice with `suggestion.passage`, `hands` and `multiplier`. */
  readonly onPractice: (suggestion: Suggestion) => void
  /** "Dismiss for this session". Omit to hide the button. */
  readonly onDismiss?: (suggestion: Suggestion) => void
  /** "Turn off suggestions". Omit to hide the button. */
  readonly onDisableSuggestions?: () => void
  /** Shown instead of the list while `disabled`. Omit to hide the button. */
  readonly onEnableSuggestions?: () => void
  /** Wording of the disable button, e.g. "Turn off suggestions for this piece". */
  readonly disableLabel?: string
  /** Optional small notation preview for a suggestion (spec: "a small notation preview"). */
  readonly renderPreview?: (suggestion: Suggestion) => ComponentChildren
}

function Heading({
  level,
  id,
  class: className,
  children,
}: {
  level: number
  id?: string
  class?: string | undefined
  children: ComponentChildren
}) {
  const Tag = `h${Math.min(6, Math.max(1, level))}` as 'h2'
  return (
    <Tag id={id} class={className}>
      {children}
    </Tag>
  )
}

function Pips({ clean, target }: { clean: number; target: number }) {
  return (
    <span class={styles.pips} aria-hidden="true">
      {Array.from({ length: target }, (_, i) => (
        <span key={i} class={styles.pip} data-filled={i < clean ? '' : undefined}>
          {i < clean ? <Icon name="check" size={12} /> : null}
        </span>
      ))}
    </span>
  )
}

export interface SuggestionCardProps {
  readonly suggestion: Suggestion
  readonly compact?: boolean
  /** Heading level of the card title. */
  readonly headingLevel: number
  readonly onPractice: (suggestion: Suggestion) => void
  readonly onDismiss?: ((suggestion: Suggestion) => void) | undefined
  readonly renderPreview?: ((suggestion: Suggestion) => ComponentChildren) | undefined
}

/** One active suggestion. */
export function SuggestionCard({
  suggestion: s,
  compact,
  headingLevel,
  onPractice,
  onDismiss,
  renderPreview,
}: SuggestionCardProps) {
  const headingId = useId()
  const kind = kindText(s.kind)
  const preview = renderPreview?.(s)
  return (
    <li class={styles.card} data-compact={compact ? '' : undefined} data-kind={s.kind} data-suggestion={s.id}>
      <article aria-labelledby={headingId}>
        <header class={styles.cardHead}>
          <Heading level={headingLevel} id={headingId} class={styles.cardTitle}>
            {barsTitle(s.bars)}
          </Heading>
          <p class={styles.facts} title={s.contextLabel}>
            <span class={styles.fact}>{handsText(s.hands)}</span>
            <span class={styles.fact}>{speedText(s.multiplier)} speed</span>
            {kind ? (
              <span class={styles.fact} data-tone="restart">
                {kind}
              </span>
            ) : null}
          </p>
        </header>

        <ol class={styles.bars} aria-label="Bars in this passage">
          {s.bars.map((bar) => (
            <li key={bar.occ} class={styles.bar} data-role={bar.role} aria-label={barSpeech(bar)}>
              <span class={styles.barNumber} aria-hidden="true">
                {bar.label}
              </span>
              <span class={styles.barRole} aria-hidden="true">
                {bar.role === 'difficult' ? 'difficult' : 'context'}
              </span>
            </li>
          ))}
        </ol>

        {preview ? <div class={styles.preview}>{preview}</div> : null}

        <p class={styles.evidence}>{s.evidence}</p>
        {s.prompt !== '' ? <p class={styles.prompt}>{s.prompt}</p> : null}
        {s.bars.some((b) => b.role === 'context') && !compact ? (
          <p class={styles.legend}>Context bars give you a lead-in and lead-out; they do not need to come out clean.</p>
        ) : null}

        <div class={styles.progress} role="img" aria-label={s.progress.text}>
          <Pips clean={s.progress.clean} target={s.progress.target} />
          <span class={styles.progressText}>{s.progress.text}</span>
        </div>

        <div class={styles.actions}>
          <Button
            variant="primary"
            icon="target"
            onClick={() => onPractice(s)}
            aria-label={`Practice this passage, ${barsTitle(s.bars).toLowerCase()}`}
          >
            Practice this passage
          </Button>
          {onDismiss ? (
            <Button
              variant="ghost"
              onClick={() => onDismiss(s)}
              aria-label={`Dismiss suggestion for ${difficultTitle(s.bars).toLowerCase()} for this session`}
            >
              Not now
            </Button>
          ) : null}
        </div>
      </article>
    </li>
  )
}

function ImprovedItem({ suggestion: s, headingLevel }: { suggestion: Suggestion; headingLevel: number }) {
  return (
    <li class={styles.improvedItem} data-suggestion={s.id}>
      <span class={styles.improvedIcon} aria-hidden="true">
        <Icon name="check" size={16} />
      </span>
      <div class={styles.improvedText}>
        <Heading level={headingLevel} class={styles.improvedTitle}>
          {barsTitle(s.bars)}
          <span class={styles.improvedContext}>
            {' '}
            · {handsText(s.hands)} at {speedText(s.multiplier)}
          </span>
        </Heading>
        <p>{s.evidence}</p>
      </div>
    </li>
  )
}

export function SuggestionList({
  suggestions,
  improved = [],
  disabled = false,
  compact = false,
  headingLevel = 2,
  title = 'Suggested practice',
  onPractice,
  onDismiss,
  onDisableSuggestions,
  onEnableSuggestions,
  disableLabel = 'Turn off suggestions',
  renderPreview,
}: SuggestionListProps) {
  const titleId = useId()
  const cardLevel = headingLevel + 1
  return (
    <section class={styles.root} data-compact={compact ? '' : undefined} aria-labelledby={titleId}>
      <header class={styles.head}>
        <Heading level={headingLevel} id={titleId} class={styles.title}>
          {title}
        </Heading>
        {!disabled && suggestions.length > 0 ? <span class={styles.count}>{suggestions.length} of up to 3</span> : null}
      </header>

      {disabled ? (
        <div class={styles.empty} data-state="disabled">
          <p>
            Suggested practice is turned off. Your practice is still recorded, so suggestions will be accurate if you
            turn it back on.
          </p>
          {onEnableSuggestions ? <Button onClick={onEnableSuggestions}>Turn on suggestions</Button> : null}
        </div>
      ) : suggestions.length === 0 ? (
        <div class={styles.empty} data-state="none">
          <p>
            Nothing to suggest right now. A bar appears here when mistakes recur across several comparable passes, never
            after a single bad one.
          </p>
        </div>
      ) : (
        <ul class={styles.cards}>
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              compact={compact}
              headingLevel={cardLevel}
              onPractice={onPractice}
              onDismiss={onDismiss}
              renderPreview={renderPreview}
            />
          ))}
        </ul>
      )}

      {improved.length > 0 ? (
        <details class={styles.improved} open={improved.length <= 3}>
          <summary>
            <Icon name="check" size={16} />
            <span>Improved ({improved.length})</span>
          </summary>
          <ul class={styles.improvedList}>
            {improved.map((s) => (
              <ImprovedItem key={s.id} suggestion={s} headingLevel={cardLevel} />
            ))}
          </ul>
        </details>
      ) : null}

      {!disabled && onDisableSuggestions ? (
        <div class={styles.footer}>
          <Button variant="ghost" onClick={onDisableSuggestions}>
            {disableLabel}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
