import { expect, test } from '../browser-test'
import { openHarness } from './render-helpers'

test.use({ reducedMotion: 'reduce' })

for (const mode of ['strip', 'page'] as const) {
  test(`the timing cue stays close to the playhead and clears high notes in the ${mode}`, async ({ page }) => {
    await openHarness(page)
    const result = await page.evaluate(async (mode) => {
      await window.harness.prepare('changes', 3, { mode, pageWidth: 600 })
      window.harness.mount({ width: 600, height: 644 }, { fitWidth: true })
      const view = window.harness.strip()!
      const score = document.querySelector('.pn-strip')!
      const viewport = score.parentElement!
      const cue = document.querySelector('[data-testid="timing-cue"]')!
      const label = cue.querySelector('.pn-timing-label')!
      const signal = cue.querySelector('.pn-timing-signal')!
      const chevrons = cue.querySelector('.pn-timing-chevrons')!
      const playhead = document.querySelector('.pn-cursor-bar')!
      const defaultCursor = getComputedStyle(playhead).backgroundColor
      view.setTimingCue(null, true)
      view.flushNow()
      const scoreTop = score.getBoundingClientRect().top
      const overlaps: number[] = []
      let maxPlayheadGap = 0
      for (const position of window.harness.onsets().slice(0, 16)) {
        view.setCursor(position, { smooth: false })
        view.setTimingCue('rushing')
        view.flushNow()
        const badge = cue.getBoundingClientRect()
        const bar = playhead.getBoundingClientRect()
        maxPlayheadGap = Math.max(maxPlayheadGap, bar.top - badge.bottom, badge.top - bar.bottom)
        const coversNote = [...document.querySelectorAll('.pn-music [data-n]')].some((head) => {
          const note = head.getBoundingClientRect()
          return (
            note.width > 0 &&
            badge.left < note.right &&
            badge.right > note.left &&
            badge.top < note.bottom &&
            badge.bottom > note.top
          )
        })
        if (coversNote) overlaps.push(position)
      }
      const size = cue.getBoundingClientRect()
      const cueStyle = getComputedStyle(cue)
      const cornerRadius = cueStyle.borderTopLeftRadius
      const borderless = cueStyle.borderWidth === '0px' && cueStyle.outlineStyle === 'none'
      const rushingGradient = cueStyle.backgroundImage
      const rushingCursor = getComputedStyle(playhead).backgroundColor
      const pointsLeft =
        signal.getBoundingClientRect().right <= label.getBoundingClientRect().left &&
        getComputedStyle(signal).scale.startsWith('-1')
      view.setTimingCue('dragging')
      view.flushNow()
      const draggingGradient = getComputedStyle(cue).backgroundImage
      const draggingCursor = getComputedStyle(playhead).backgroundColor
      const pointsRight =
        signal.getBoundingClientRect().left >= label.getBoundingClientRect().right &&
        !getComputedStyle(signal).scale.startsWith('-1')
      view.setTimingCue(null, true)
      view.flushNow()
      const clearedCursor = getComputedStyle(playhead).backgroundColor
      view.setTimingCue('dragging')
      view.flushNow()
      return {
        overlaps,
        scoreStayedPut: scoreTop === score.getBoundingClientRect().top,
        size: { width: size.width, height: size.height },
        cornerRadius,
        borderless,
        maxPlayheadGap,
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
        static: [cue, chevrons].every((element) => getComputedStyle(element).animationName === 'none'),
        scoreHasNoVignette: ['::before', '::after'].every(
          (pseudo) => getComputedStyle(viewport, pseudo).backgroundImage === 'none',
        ),
      }
    }, mode)
    await expect(page.getByTestId('timing-cue')).toBeVisible()
    expect(result).toMatchObject({
      overlaps: [],
      scoreStayedPut: true,
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
    expect(result.maxPlayheadGap).toBeLessThan(80)
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
    const arrows = document.querySelector('.pn-timing-chevrons')!
    const directions = (['rushing', 'dragging'] as const).map((direction) => {
      view.setTimingCue(direction)
      view.flushNow()
      return [
        { element: arrows, position: () => arrows.getBoundingClientRect().x },
        { element: cue, position: () => Number.parseFloat(getComputedStyle(cue).backgroundPositionX) },
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
    view.setTimingCue(null, true)
    view.flushNow()
    return { directions, stopsWhenHidden: cue.getAnimations({ subtree: true }).length === 0 }
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
    stopsWhenHidden: true,
  })
})
