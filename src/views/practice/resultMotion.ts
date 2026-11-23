/**
 * The result pill growing into its details and folding back (DECISIONS U110, U130), drawn with
 * transform, clip-path and opacity only: the expanded card is laid out once at its final size, and
 * these keyframes make it start from the pill's rectangle (a FLIP from the measured pill).
 *
 * - Tablet (`panel`): the details panel rises from behind the summary row (a translate, so its
 *   top edge and border lead the way), the panel and the row are clipped from the pill's sides to
 *   the card's while an outline (corners and sides, moved and stretched) draws the edges the clips
 *   cut, the summary's two ends slide from the pill's edges to the card's (its actions, which differ
 *   from the pill's, fade in). A clip on the card, the row's sides and rounded bottom, hides the part of
 *   the rising panel that is still below the row.
 * - Phone (`screen`): the full-screen panel is translated to the pill's top and clipped to the
 *   pill's rectangle, then grows to the whole screen while its surface fades in over the pill.
 *
 * The contents (the details, a phone's header) stay transparent while the side clip still reaches
 * into their padding, so no letter, bullet or excerpt is ever cut by it: first the empty surface
 * grows from the pill, then the contents fade in (`clearOfContent`), and a fold fades them out
 * before the surface shrinks.
 *
 * Folding plays the same animations backwards from wherever they are (a quick second tap reverses
 * mid-way). Nothing here measures: the caller passes rectangles taken once before and once after the
 * expanded layout.
 */

export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * The fold when the next pass starts (U101): the same motion backwards, this short, so it never
 * holds up what the learner is playing.
 */
export const QUICK_FOLD_MS = 140

/** The properties an opening or fold may animate (none of them lays anything out). */
export const MOTION_PROPERTIES: ReadonlySet<string> = new Set(['transform', 'clipPath', 'opacity'])

/** The elements the tablet opening moves; any may be missing (nothing is animated for it). */
export interface PanelParts {
  readonly card: Element | null
  readonly panel: Element | null
  /** The panel's contents (not a phone header). */
  readonly content: readonly Element[]
  readonly row: Element | null
  readonly summary: Element | null
  /** The badge and the text, at the start edge of the summary. */
  readonly start: readonly Element[]
  /** The actions, at the end edge of the summary (they differ from the pill's: they fade in). */
  readonly end: Element | null
  /**
   * The card's outline while it grows (its sides are clipped, so their borders are drawn here):
   * the corners top-left, top-right, bottom-left, bottom-right, then the left and right sides.
   */
  readonly outline: readonly Element[]
  /** What the pill showed of the card, kept where it was: it fades as the summary comes down over it. */
  readonly peek?: Element | null
}

/** The peek fades out over the opening's first third (and back in over a fold's last). */
const PEEK_FADE: Keyframe[] = [{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }]

export interface MotionStep {
  readonly target: Element
  readonly keyframes: Keyframe[]
  /** This step's own timing function (default: the opening's). */
  readonly easing?: string
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`

/**
 * The eased progress from which a side clip that starts `side` px inside an edge, and opens to
 * nothing on the opening's own easing, no longer reaches content `inset` px inside that edge (with
 * 1 px to spare); 0 when it never does.
 */
export function clearOfContent(side: number, inset: number): number {
  const room = Math.max(0, inset - 1)
  return side <= room ? 0 : Math.min(1, 1 - room / side)
}

/** Opacity held at 0 until `from` (eased progress), then up to 1 at the end. */
function fadeInFrom(from: number): Keyframe[] {
  const at = Math.round(from * 1e4) / 1e4
  return at > 0 ? [{ opacity: 0 }, { opacity: 0, offset: at }, { opacity: 1 }] : [{ opacity: 0 }, { opacity: 1 }]
}

/**
 * Corner radius of the expanded tablet card (CSS `.resultDetails`, `.resultCard[data-expanded]
 * .result`, `.resultOutline`), used for the growing shape from the start.
 */
export const CARD_RADIUS = 24

/**
 * The tablet opening: `pill` is the pill's rectangle before expanding, `card` the summary row's
 * (the card's own box) after, `panelTop` the top of the laid-out details, `viewport` the window
 * size (the clips reach that far above the card, over the panel), `contentInset` how far inside the
 * panel's sides its contents begin (their padding), `summaryShift` how much higher the summary was in
 * the pill than it is in the row (default: as much as the pill was taller).
 */
export function panelOpening(
  parts: PanelParts,
  pill: Box,
  card: Box,
  panelTop: number,
  viewport: { readonly height: number },
  contentInset = 24,
  summaryShift?: number,
): MotionStep[] {
  const left = Math.max(0, pill.left - card.left)
  const right = Math.max(0, card.right - pill.right)
  // The summary sits this much higher in the pill (its preview lines were under it).
  const shift = Math.max(0, card.top - pill.top)
  // How much of the panel shows above the row at the start: the pill's height above the row, plus
  // the 1 px the panel overlaps the row.
  const peek = shift + 1
  // How far the card's top edge travels.
  const rise = Math.max(0, pill.top - panelTop)
  const R = px(CARD_RADIUS)
  const far = px(viewport.height + shift)
  const steps: MotionStep[] = []
  const add = (target: Element | null | undefined, keyframes: Keyframe[], easing?: string) => {
    if (target) steps.push(easing ? { target, keyframes, easing } : { target, keyframes })
  }
  // The card's own outline, the sides and rounded bottom corners of the row: nothing of the rising
  // panel shows below the card or in its bottom corners, only behind the row.
  add(parts.card, [
    { clipPath: `inset(-${far} ${px(right)} 0px ${px(left)} round 0px 0px ${R} ${R})` },
    { clipPath: `inset(-${far} 0px 0px 0px round 0px 0px ${R} ${R})` },
  ])
  add(parts.panel, [
    {
      transform: `translateY(calc(100% - ${px(peek)}))`,
      clipPath: `inset(0px ${px(right)} 0px ${px(left)} round ${R} ${R} 0px 0px)`,
    },
    { transform: 'translateY(0px)', clipPath: `inset(0px 0px 0px 0px round ${R} ${R} 0px 0px)` },
  ])
  // On the panel's own easing, so its keyframe follows the clip exactly.
  const fadeIn = fadeInFrom(clearOfContent(Math.max(left, right), contentInset))
  for (const el of parts.content) add(el, fadeIn)
  const top = px(shift + 16)
  add(parts.row, [
    { clipPath: `inset(-${top} ${px(right)} 0px ${px(left)} round 0px 0px ${R} ${R})` },
    { clipPath: `inset(-${top} 0px 0px 0px round 0px 0px ${R} ${R})` },
  ])
  add(parts.summary, [{ transform: `translateY(${px(-(summaryShift ?? shift))})` }, { transform: 'translateY(0px)' }])
  add(parts.peek, PEEK_FADE)
  for (const el of parts.start) add(el, [{ transform: `translateX(${px(left)})` }, { transform: 'translateX(0px)' }])
  add(parts.end, [
    { transform: `translateX(${px(-right)})`, opacity: 0 },
    { transform: `translateX(${px(-right * 0.5)})`, opacity: 1, offset: 0.5 },
    { transform: 'translateX(0px)', opacity: 1 },
  ])
  // The outline: corners move with the edges, the sides also grow from the pill's height.
  const [tl, tr, bl, br, sideLeft, sideRight] = parts.outline
  const corner = (dx: number, dy: number): Keyframe[] => [
    { transform: `translate(${px(dx)}, ${px(dy)})`, opacity: 1 },
    { transform: 'translate(0px, 0px)', opacity: 1 },
  ]
  add(tl, corner(left, rise))
  add(tr, corner(-right, rise))
  add(bl, corner(left, 0))
  add(br, corner(-right, 0))
  const full = Math.max(1, card.bottom - panelTop - 2 * CARD_RADIUS)
  const from = Math.max(0, pill.bottom - pill.top - 2 * CARD_RADIUS) / full
  const side = (dx: number): Keyframe[] => [
    { transform: `translateX(${px(dx)}) scaleY(${Math.round(from * 1e4) / 1e4})`, opacity: 1 },
    { transform: 'translateX(0px) scaleY(1)', opacity: 1 },
  ]
  add(sideLeft, side(left))
  add(sideRight, side(-right))
  return steps
}

/**
 * The phone opening: the full-screen panel (`screen`, its box the viewport) starts as the pill's
 * rectangle and its surface fades in over the pill while it grows; its contents (`content`: the
 * header and the details, `contentInset` px inside the screen's sides) fade in once the side clip is
 * clear of them.
 */
export function screenOpening(
  panel: Element | null,
  pill: Box,
  screen: Box,
  radius: number,
  content: readonly Element[] = [],
  contentInset = 8,
  peek: Element | null = null,
): MotionStep[] {
  if (!panel) return []
  const height = screen.bottom - screen.top
  const width = screen.right - screen.left
  const top = pill.top - screen.top
  const left = Math.max(0, pill.left - screen.left)
  const right = Math.max(0, width - (pill.right - screen.left))
  const steps: MotionStep[] = [
    {
      target: panel,
      keyframes: [
        {
          transform: `translateY(${px(top)})`,
          clipPath: `inset(0px ${px(right)} ${px(Math.max(0, height - (pill.bottom - pill.top)))} ${px(left)} round ${px(
            radius,
          )})`,
          opacity: 0,
        },
        { opacity: 1, offset: 0.35 },
        { transform: 'translateY(0px)', clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 },
      ],
    },
  ]
  const clear = clearOfContent(Math.max(left, right), contentInset)
  if (clear > 0) for (const target of content) steps.push({ target, keyframes: fadeInFrom(clear) })
  if (peek) steps.push({ target: peek, keyframes: PEEK_FADE })
  return steps
}

/**
 * Starts the steps. `backwards` fill only: the start frame holds before the first frame and after a
 * fold has played back to it, and nothing remains on the expanded card once it has opened.
 */
export function startMotion(steps: readonly MotionStep[], duration: number, easing: string): Animation[] {
  const animations: Animation[] = []
  for (const step of steps) {
    if (typeof (step.target as Partial<Element>).animate !== 'function') continue
    animations.push(step.target.animate(step.keyframes, { duration, easing: step.easing ?? easing, fill: 'backwards' }))
  }
  return animations
}

/**
 * Brings an element that appeared while the motion runs (the details replacing their loading line)
 * in at the same point, direction and speed as `reference`, one of the motion's animations.
 */
export function joinMotion(
  target: Element,
  keyframes: Keyframe[],
  reference: Animation,
  duration: number,
  easing: string,
): Animation | null {
  if (typeof (target as Partial<Element>).animate !== 'function') return null
  const animation = target.animate(keyframes, { duration, easing, fill: 'backwards' })
  animation.playbackRate = reference.playbackRate
  animation.currentTime = reference.currentTime
  return animation
}

/**
 * Plays the animations forward (opening) or backward (folding) from wherever they are; `speed`
 * shortens a fold (the next pass starting, U101).
 */
export function steerMotion(animations: readonly Animation[], closing: boolean, speed = 1): void {
  const rate = closing ? -speed : 1
  for (const animation of animations) {
    // Unchanged: leave it be (running, or finished where it should be: playing it again would
    // rewind a finished opening to its start).
    if (animation.playbackRate === rate) continue
    animation.playbackRate = rate
    animation.play()
  }
}
