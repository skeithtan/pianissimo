/**
 * Helpers for happy-dom component tests (`// @vitest-environment happy-dom` at the top of the
 * test file). Every interaction runs inside Preact's `act` so effects and re-renders have
 * settled when the helper returns. Not imported by production code.
 */
import { render, type ComponentChild } from 'preact'
import { act } from 'preact/test-utils'

export interface Mounted {
  readonly container: HTMLElement
  rerender(vnode: ComponentChild): void
  unmount(): void
}

/** Render into a fresh container attached to `document.body`. */
export function mount(vnode: ComponentChild): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => render(vnode, container))
  return {
    container,
    rerender: (next) => act(() => render(next, container)),
    unmount: () => {
      act(() => render(null, container))
      container.remove()
    },
  }
}

/** Run `fn` inside `act` (state changes made outside a helper). */
export function flush(fn: () => void = () => undefined): void {
  act(fn)
}

export function click(element: Element | null | undefined): void {
  if (!element) throw new Error('click: element not found')
  act(() => {
    ;(element as HTMLElement).click()
  })
}

/** Set an input's value the way typing would, firing `input` then `change`. */
export function type(element: Element | null | undefined, value: string): void {
  if (!element) throw new Error('type: element not found')
  const input = element as HTMLInputElement
  act(() => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export function press(element: Element | null | undefined, key: string): void {
  if (!element) throw new Error('press: element not found')
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

export function $(root: ParentNode, selector: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(selector)
}

export function $$(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)]
}

/** First element whose text content equals `text` (trimmed), optionally limited to a selector. */
export function byText(root: ParentNode, text: string, selector = '*'): HTMLElement | null {
  return $$(root, selector).find((el) => el.children.length === 0 && el.textContent?.trim() === text) ?? null
}

/** Interactive element by accessible name (`aria-label`, or its own text for buttons). */
export function byLabel(root: ParentNode, label: string): HTMLElement | null {
  return (
    $$(root, '[aria-label]').find((el) => el.getAttribute('aria-label') === label) ??
    $$(root, 'button').find((el) => el.textContent?.trim() === label) ??
    null
  )
}
