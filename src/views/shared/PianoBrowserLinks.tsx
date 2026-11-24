import { msg } from '../../i18n/messages'
/**
 * The way to a browser that can connect a piano: its links, and this site's address to open there.
 * Used by the Library card and by the piano setup.
 */
import { pianoBrowsers } from '../../app/pianoBrowsers'
import { LinkButton } from '../../ui/controls'
import { CopyButton } from './CopyButton'

export function PianoBrowserLinks() {
  const { app, browsers } = pianoBrowsers()
  return (
    <>
      {browsers.map((b) => (
        <LinkButton key={b.name} variant={app ? 'primary' : 'secondary'} href={b.url}>
          {msg('Get {0}', b.name)}
        </LinkButton>
      ))}
      <CopyButton
        text={() => new URL(import.meta.env.BASE_URL, location.href).href}
        label={msg('Copy this address')}
        copiedLabel={msg('Copied')}
      />
    </>
  )
}
