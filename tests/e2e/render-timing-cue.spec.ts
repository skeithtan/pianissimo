import { expect, test } from '../browser-test'
import { openHarness } from './render-helpers'

test.use({ reducedMotion: 'reduce' })

for (const mode of ['strip', 'page'] as const) {
  test(`the timing cue stays close to the cursor at one height in the ${mode}`, async ({ page }) => {
    await openHarness(page)
    const result = await page.evaluate(async (mode) => {
      await window.harness.prepare('changes', 3, { mode, pageWidth: 600 })
      window.harness.mount({ width: 600, height: 644 }, { fitWidth: true })
      const view = window.harness.strip()!
      const score = document.querySelector('.pn-strip')!
      const viewport = score.parentElement!
      const cue = document.querySelector('[data-testid="timing-cue"]')!
      const sweep = cue.querySelector('.pn-timing-sweep')!
      const label = cue.querySelector('.pn-timing-label')!
      const signal = cue.querySelector('.pn-timing-signal')!
      const chevrons = cue.querySelector('.pn-timing-chevrons')!
      const playhead = document.querySelector('.pn-cursor-bar')!
      const defaultCursor = getComputedStyle(playhead).backgroundColor
      view.setTimingCue(null, true)
      view.flushNow()
      const scoreTop = score.getBoundingClientRect().top
      const overlaps: number[] = []
      const cueTops = new Set<number>()
      let maxHorizontalOffset = 0
      let maxVerticalGap = 0
      let cueInStage = true
      for (const position of window.harness.onsets()) {
        view.setCursor(position, { smooth: false })
        view.setTimingCue('rushing')
        view.flushNow()
        const badge = cue.getBoundingClientRect()
        const bar = playhead.getBoundingClientRect()
        const stage = viewport.getBoundingClientRect()
        const inset = badge.width / 2 + 8
        const expectedX = Math.max(stage.left + inset, Math.min(bar.left + bar.width / 2, stage.right - inset))
        maxHorizontalOffset = Math.max(maxHorizontalOffset, Math.abs(badge.left + badge.width / 2 - expectedX))
        maxVerticalGap = Math.max(maxVerticalGap, bar.top - badge.bottom)
        cueTops.add(badge.top)
        cueInStage &&= badge.top >= stage.top && badge.bottom <= stage.bottom
        const coversNote = [...document.querySelectorAll('.pn-music [data-n]')].some((head) => {
          const note = head.getBoundingClientRect()
          // A page system can scroll above the score viewport and is clipped there.
          const visibleTop = Math.max(note.top, scoreTop)
          return (
            note.width > 0 &&
            note.bottom > visibleTop &&
            badge.left < note.right &&
            badge.right > note.left &&
            badge.top < note.bottom &&
            badge.bottom > visibleTop
          )
        })
        if (coversNote) overlaps.push(position)
      }
      const size = cue.getBoundingClientRect()
      const cueStyle = getComputedStyle(cue)
      const cornerRadius = cueStyle.borderTopLeftRadius
      const borderless = cueStyle.borderWidth === '0px' && cueStyle.outlineStyle === 'none'
      const rushingGradient = getComputedStyle(sweep).backgroundImage
      const rushingCursor = getComputedStyle(playhead).backgroundColor
      const pointsLeft =
        signal.getBoundingClientRect().right <= label.getBoundingClientRect().left &&
        getComputedStyle(signal).scale.startsWith('-1')
      view.setTimingCue('dragging')
      view.flushNow()
      cueTops.add(cue.getBoundingClientRect().top)
      const draggingGradient = getComputedStyle(sweep).backgroundImage
      const draggingCursor = getComputedStyle(playhead).backgroundColor
      const pointsRight =
        signal.getBoundingClientRect().left >= label.getBoundingClientRect().right &&
        !getComputedStyle(signal).scale.startsWith('-1')
      view.setTimingCue(null, true)
      view.flushNow()
      const clearedCursor = getComputedStyle(playhead).backgroundColor
      view.setTimingCue('dragging')
      view.flushNow()
      cueTops.add(cue.getBoundingClientRect().top)
      return {
        overlaps,
        scoreStayedPut: scoreTop === score.getBoundingClientRect().top,
        cueInStage,
        cueVerticalPositions: cueTops.size,
        maxHorizontalOffset,
        maxVerticalGap,
        size: { width: size.width, height: size.height },
        cornerRadius,
        borderless,
        pointsLeft,
        pointsRight,
        gradientsDiffer:
          rushingGradient.startsWith('repeating-linear-gradient') &&
          draggingGradient.startsWith('repeating-linear-gradient') &&
          rushingGradient !== draggingGradient,
        unifiedBackground: [signal, label].every((part) => {
          const style = getComputedStyle(part)
          return style.backgroundImage === 'none' && style.backgroundColor === 'rgba(0, 0, 0, 0)'
        }),
        cursorColorsDiffer: new Set([defaultCursor, rushingCursor, draggingCursor]).size === 3,
        cursorResetsWithCue: clearedCursor === defaultCursor,
        static: [sweep, chevrons, ...chevrons.children].every(
          (element) => getComputedStyle(element).animationName === 'none',
        ),
        scoreHasNoVignette: ['::before', '::after'].every(
          (pseudo) => getComputedStyle(viewport, pseudo).backgroundImage === 'none',
        ),
      }
    }, mode)
    await expect(page.getByTestId('timing-cue')).toBeVisible()
    expect(result).toMatchObject({
      overlaps: [],
      scoreStayedPut: true,
      cueInStage: true,
      cueVerticalPositions: 1,
      size: { width: 158, height: 36 },
      cornerRadius: '8px',
      borderless: true,
      pointsLeft: true,
      pointsRight: true,
      gradientsDiffer: true,
      unifiedBackground: true,
      cursorColorsDiffer: true,
      cursorResetsWithCue: true,
      static: true,
      scoreHasNoVignette: true,
    })
    expect(result.maxHorizontalOffset).toBeLessThan(2)
    expect(result.maxVerticalGap).toBeLessThan(64)
  })
}

test('the timing gradient and chevrons repeat in the cue direction while it is visible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openHarness(page)
  const motions = await page.evaluate(async () => {
    await window.harness.prepare('basic')
    window.harness.mount()
    const view = window.harness.strip()!
    const cue = document.querySelector('.pn-timing-cue')!
    const sweep = cue.querySelector('.pn-timing-sweep')!
    const arrows = document.querySelector('.pn-timing-chevrons')!
    const directions = (['rushing', 'dragging'] as const).map((direction) => {
      view.setTimingCue(direction)
      view.flushNow()
      return [
        { element: arrows, position: () => arrows.getBoundingClientRect().x },
        { element: sweep, position: () => sweep.getBoundingClientRect().x },
      ].map(({ element, position }) => {
        const style = getComputedStyle(element)
        const animation = element.getAnimations()[0]
        animation?.pause()
        const [start, first, second, repeatFirst, repeatSecond] = [0, 100, 300, 1700, 1900].map((time) => {
          if (animation) animation.currentTime = time
          return position()
        })
        return {
          name: style.animationName,
          repetitions: style.animationIterationCount,
          movesInDirection:
            direction === 'rushing' ? start! > first! && first! > second! : start! < first! && first! < second!,
          repeats: Math.abs(first! - repeatFirst!) < 0.1 && Math.abs(second! - repeatSecond!) < 0.1,
        }
      })
    })
    // Only compositor-friendly properties animate (no background or mask repaint per frame).
    const animated = new Set(
      cue
        .getAnimations({ subtree: true })
        .flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes())
        .flatMap((keyframe) =>
          Object.keys(keyframe).filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)),
        ),
    )
    view.setTimingCue(null, true)
    view.flushNow()
    return {
      directions,
      animatedProperties: [...animated].sort(),
      stopsWhenHidden: cue.getAnimations({ subtree: true }).length === 0,
    }
  })
  expect(motions).toEqual({
    directions: Array.from({ length: 2 }, () =>
      ['pn-timing-flow', 'pn-timing-gradient'].map((name) => ({
        name,
        repetitions: 'infinite',
        movesInDirection: true,
        repeats: true,
      })),
    ),
    animatedProperties: ['opacity', 'transform'],
    stopsWhenHidden: true,
  })
})

test('in the page view the cue row opening and a rewind as it closes both glide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openHarness(page)
  const runs = await page.evaluate(async () => {
    await window.harness.prepare('long-40', 3, { mode: 'page', pageWidth: 600 })
    window.harness.mount({ width: 600, height: 644 }, { fitWidth: true })
    const view = window.harness.strip()!
    const root = document.querySelector('.pn-strip')!
    const cursor = root.querySelector('.pn-cursor')!
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
    const settle = async () => {
      for (let i = 0; i < 30; i++) await frame()
    }
    // Where the current system is drawn: the cursor rides on the sheet, glide included.
    const top = () => Math.round(cursor.getBoundingClientRect().top - root.getBoundingClientRect().top)
    const sample = async (act: () => void) => {
      const tops = [top()]
      act()
      for (let i = 0; i < 26; i++) {
        await frame()
        tops.push(top())
      }
      return tops
    }
    const occs = window.harness.layout()!.occurrences
    view.setCursor(occs[Math.floor(occs.length / 2)]!.start, { smooth: false })
    view.flushNow()
    await settle()
    const opening = await sample(() => view.setTimingCue(null, true))
    await settle()
    const rewind = await sample(() => {
      view.setTimingCue(null, false)
      view.wrapTo(0, { rewind: true })
    })
    return { opening, rewind }
  })
  for (const tops of [runs.opening, runs.rewind]) {
    // Several distinct places on the way, never a jump straight to the end.
    expect(new Set(tops).size).toBeGreaterThan(5)
    expect(tops[1]).not.toBe(tops.at(-1))
  }
  expect(runs.opening.at(-1)).toBeLessThan(runs.opening[0]!)
})
