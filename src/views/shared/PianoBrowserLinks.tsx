import { msg } from '../../i18n/messages'
/**
 * The way to a browser that can connect a piano: its links, and this site's address to open there.
 * Used by the Library card and by the piano setup.
 */
import { useEffect, useState } from 'preact/hooks'
import { pianoBrowsers } from '../../app/pianoBrowsers'
import { Button, LinkButton } from '../../ui/controls'

const COPIED_MS = 2000

export function PianoBrowserLinks() {
  const { app, browsers } = pianoBrowsers()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(import.meta.env.BASE_URL, location.href).href)
      setCopied(true)
    } catch {
      // Refused: the address bar still has it.
    }
  }

  return (
    <>
      {browsers.map((b) => (
        <LinkButton key={b.name} variant={app ? 'primary' : 'secondary'} href={b.url}>
          {msg('Get {0}', b.name)}
        </LinkButton>
      ))}
      {navigator.clipboard ? (
        <Button variant="ghost" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          <span aria-live="polite">{copied ? msg('Copied') : msg('Copy this address')}</span>
        </Button>
      ) : null}
    </>
  )
}
