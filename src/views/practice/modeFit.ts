/**
 * What a tablet's or desktop's header has room for (DECISIONS U141). The four modes sit centered,
 * so both sides get the room the fuller one needs: Back and a readable title at the start, a take's
 * controls or pill in full, the connection chip as its dot and Settings at the end. Where they do
 * not fit, the header names the mode in one button instead. The chip keeps its words where enough
 * of them would show, else it is its dot.
 *
 * Measured when the header, the modes (the language) or a take's controls change size or come and
 * go, never on a render. Nothing measured depends on the answer, so it cannot flip back.
 *
 * During a take the header goes to the one button at most once: it stays with it until the take's
 * controls are gone or the header's width changes.
 */
import type { RefObject } from 'preact'
import { useLayoutEffect, useState } from 'preact/hooks'

/** The title's readable minimum (px). */
export const TITLE_MIN_PX = 96
/** The narrowest chip whose words still say something; its dot below that. */
export const CHIP_WORDS_PX = 148
/** The connection chip as its dot, and Settings (`--touch`). */
const TOUCH_PX = 48
/** Between the chip and Settings, and a take and the chip (`--space-2`). */
const TOOL_GAP_PX = 8
/** Between the three parts of the header (`--space-3`), and Back and the title. */
const GAP_PX = 12
const BACK_GAP_PX = 6

/** A take (0 without one) with the gap after it. */
const takeRoom = (take: number): number => (take > 0 ? take + TOOL_GAP_PX : 0)

export interface HeaderWidths {
  /** The header without its padding. */
  readonly inner: number
  readonly back: number
  /** The four modes. */
  readonly choice: number
  /** A take's controls or pill with all their words; 0 without one. */
  readonly take: number
}

export function choiceFits({ inner, back, choice, take }: HeaderWidths): boolean {
  const start = back + BACK_GAP_PX + TITLE_MIN_PX
  const end = takeRoom(take) + TOUCH_PX + TOOL_GAP_PX + TOUCH_PX
  return 2 * (Math.max(start, end) + GAP_PX) + choice <= inner
}

/** Has the chip room for its words, in tools this wide with this take? */
export function chipFits(tools: number, take: number): boolean {
  return tools - takeRoom(take) - TOOL_GAP_PX - TOUCH_PX >= CHIP_WORDS_PX
}

/** An element's width with every shortened text in it shown in full. */
function fullWidth(el: Element): number {
  let width = el.getBoundingClientRect().width
  for (const child of Array.from(el.querySelectorAll('*')))
    if (child.scrollWidth > child.clientWidth && getComputedStyle(child).overflowX === 'hidden')
      width += child.scrollWidth - child.clientWidth
  return width
}

export interface HeaderFit {
  /** All four modes are shown, not the one button. */
  readonly modes: boolean
  /** The connection chip shows its words. */
  readonly chip: boolean
}

/**
 * `mounted`: the header is on screen (a phone has none). In it, `[data-mode-choice]` wraps the four
 * modes at their natural width (also while hidden), and `[data-header-tools]` holds a take's
 * `[data-recording-control]`.
 */
export function useModeFit(header: RefObject<HTMLElement | null>, mounted: boolean): HeaderFit {
  const [modes, setModes] = useState(true)
  const [chip, setChip] = useState(true)
  useLayoutEffect(() => {
    const el = header.current
    const tools = el?.querySelector<HTMLElement>('[data-header-tools]')
    if (!mounted || !el || !tools) return
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return
    /** The header's width at which a take in progress left the modes no room. */
    let tight = 0
    const check = () => {
      const style = getComputedStyle(el)
      const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const choice = el.querySelector<HTMLElement>('[data-mode-choice] > *')?.offsetWidth ?? 0
      if (!(inner > 0) || choice <= 0) return
      const control = tools.querySelector('[data-recording-control]')
      const take = control ? fullWidth(control) : 0
      const fit = choiceFits({ inner, back: el.querySelector('button')?.offsetWidth ?? 0, choice, take })
      const held = take > 0 && tight === inner
      tight = take > 0 && (held || !fit) ? inner : 0
      setModes(fit && !held)
      setChip(chipFits(tools.clientWidth, take))
    }
    const resize = new ResizeObserver(check)
    const follow = () => {
      resize.disconnect()
      for (const part of [el, tools, ...Array.from(el.querySelectorAll('[data-mode-choice] > *'))]) resize.observe(part)
      const control = tools.querySelector('[data-recording-control]')
      if (control) resize.observe(control)
      check()
    }
    const changes = new MutationObserver(follow)
    changes.observe(tools, { childList: true, subtree: true })
    follow()
    return () => {
      resize.disconnect()
      changes.disconnect()
    }
  }, [header, mounted])
  return { modes, chip }
}
