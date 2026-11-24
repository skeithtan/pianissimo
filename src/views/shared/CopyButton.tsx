/** Copies a text and says so for a moment. Draws nothing where the clipboard cannot be written. */
import { useEffect, useState } from 'preact/hooks'
import { Button } from '../../ui/controls'

const COPIED_MS = 2000

export function CopyButton({
  text,
  label,
  copiedLabel,
  variant = 'ghost',
}: {
  text: () => string
  label: string
  copiedLabel: string
  variant?: 'secondary' | 'ghost'
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text())
      setCopied(true)
    } catch {
      // Refused: the text is still on screen (or in the address bar).
    }
  }

  return navigator.clipboard ? (
    <Button variant={variant} icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </Button>
  ) : null
}
