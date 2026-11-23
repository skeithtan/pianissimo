import { msg } from '../../i18n/messages'
/** The Library's search field (L13): never focused by itself, so no keyboard pops up on a tablet. */
import { useRef } from 'preact/hooks'
import { Button } from '../../ui/controls'
import styles from './LibraryPage.module.css'

export function SearchField({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div class={styles.search}>
      <input
        ref={input}
        type="search"
        autoComplete="off"
        spellcheck={false}
        aria-label={msg('Search pieces')}
        placeholder={msg('Search pieces')}
        value={query}
        onInput={(e) => onQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || query === '') return
          e.preventDefault()
          onQuery('')
        }}
      />
      {query ? (
        <Button
          variant="ghost"
          icon="close"
          aria-label={msg('Clear search')}
          // A press leaves the focus where it is; a key's click goes back to the field.
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            onQuery('')
            if (e.detail === 0) input.current?.focus()
          }}
        />
      ) : null}
    </div>
  )
}
