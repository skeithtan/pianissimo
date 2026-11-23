# views/shared/suggestions — the suggested-practice list

The list of a piece's suggestions (`SuggestionList`, shown in Progress, U148) and its data
(`PieceSuggestionsModel`, also used by the Library's Continue card). Spec: "Suggested practice" (all
subsections), acceptance rows Suggested practice, Suggested passage action, Suggestion recovery. The list
fetches nothing, starts nothing and owns no state; its callers decide what each action does.

`PieceSuggestionsModel` (`pieceSuggestions.ts`): `start()` / `load()` (`storage.loadSuggestions(pieceId,
sessionDismissals)`: up to three plus Improved, refreshed when the history writer reports changes),
`dismiss(id)` for this session, `setDisabled(bool)` the per-piece switch. `practiceRequestFor(pieceId, s)` is
what Practice these bars opens from the Library.

## Props (`SuggestionListProps`)

| Prop | Meaning |
| --- | --- |
| `suggestions: readonly Suggestion[]` | `SuggestionSelection.active`: ranked, capped at three, session dismissals already removed. |
| `improved?: readonly Suggestion[]` | `SuggestionSelection.improved`: shown in a folded "Improved (n)" list. Read-only, no actions. |
| `disabled?: boolean` | Suggestions are off (global setting or this piece). Shows an explanation instead of the list; practice is still recorded while off. |
| `compact?: boolean` | Tighter cards without the context-bar legend (Progress). |
| `headingLevel?: 2 \| 3 \| 4` | Level of the section title (default 2); card titles use the next level. |
| `title?: string` | Section title (default "Suggested practice"). |
| `onPractice(s)` | **Practice these bars.** Repeat over `s.passage` with `s.hands` and `s.multiplier`; never start automatically (spec). |
| `onDismiss?(s)` | "Not now": dismiss for this session (`sessionDismissals.dismiss(s.id)`, then reload). Button hidden when omitted. |
| `onDisableSuggestions?()` | "Turn off suggestions" footer button (hidden when omitted or while disabled). |
| `onEnableSuggestions?()` | "Turn on suggestions" in the disabled state. Omit when the switch is the global Settings one (the caller can show a link to Settings instead). |
| `disableLabel?` | Wording of the disable button, e.g. "Turn off suggestions for this piece". |
| `renderPreview?(s)` | Optional slot for the small notation preview the spec asks for. Rendered on `--score-paper`; Progress does not use it yet (a preview needs a cached `PreparedLayout`, see WP9 item 2). |

`SuggestionCard` is exported too (one `<li>` with the same props per suggestion) for callers that
lay their own list out.

## What a card shows

- Title from the bars ("Bars 12–14", "Bar 13"; repeat passes read "12 (pass 2)"), then hand and
  speed ("Both hands", "0.75× speed") and, for repeated-restart suggestions, a "Repeated restarts"
  tag.
- One chip per bar. **Difficult** bars are solid with a border and the word "difficult";
  **context** bars are dashed, muted and say "context", so the distinction never rests on
  color. Each chip has an `aria-label` ("Bar 13, difficult bar").
- Evidence exactly as `core/history` words it ("Mistakes in bar 13 on 3 of your last 5 comparable
  passes."), a one-line explanation that context bars need
  not come out clean (not in compact mode), recovery progress as three pips plus text ("2 of 3
  clean passes"), and the actions.

Everything is plain text from the `Suggestion` objects; the component adds no claims of its own.

## Other exports

- `sessionDismissals`: the one shared `SessionDismissals` instance, so a dismissal in Progress
  also hides it on the Continue card. In memory only.
- `barsTitle`, `difficultTitle`, `handsText`, `speedText`: the pure text helpers used above.

## Styling and tests

`suggestions.module.css` uses theme tokens only (a node test scans for literal colors), reviewed
in light and dark at 360 px and iPad widths. Touch targets use the shared `Button` (48 px).
`SuggestionList.test.tsx` (happy-dom) builds real suggestions through `selectSuggestions` and
checks bars and roles, evidence and progress text, each callback, improved list, disabled and
empty states, compact mode, preview slot and heading levels. Run
`npx vitest run src/views/shared/suggestions`.
