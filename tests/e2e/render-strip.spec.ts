/**
 * StripView in real browsers (spec "Practice screen", ottava and wrong-key feedback, "Deferred
 * assets", "Live rendering isolation"): cursor placement, zoom, browsing, passage handles, label
 * fades, warnings, sanitization and lazy loading of the notation engine.
 */
import { expect, test, type Page } from '../browser-test'
import { openHarness } from './render-helpers'

async function setup(page: Page, name = 'changes', size = { width: 1000, height: 360 }): Promise<void> {
  await openHarness(page)
  await page.evaluate(
    async ([n, s]) => {
      await window.harness.prepare(n as string)
      window.harness.mount(s as { width: number; height: number })
    },
    [name, size] as const,
  )
}

const rect = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect)

test('the notation engine is fetched only when a layout is prepared', async ({ page }) => {
  await openHarness(page)
  const osmdRequests = () =>
    page.evaluate(
      () => performance.getEntriesByType('resource').filter((e) => /opensheetmusicdisplay/i.test(e.name)).length,
    )
  expect(await osmdRequests()).toBe(0)
  await page.evaluate(() => window.harness.prepare('basic'))
  expect(await osmdRequests()).toBeGreaterThan(0)
})

test('cursor remains fixed at one third across at the beginning, middle, and end', async ({ page }) => {
  await setup(page, 'long-500', { width: 900, height: 360 })
  const host = await rect(page, '#strip-host')
  const cursorCenter = async () => {
    const r = await rect(page, '.pn-cursor')
    return r.x + r.width / 2 - host.x
  }
  expect(await cursorCenter()).toBeCloseTo(300, 0)
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setCursor(window.harness.onsets()[400]!, { smooth: false })
    s.flushNow()
  })
  expect(Math.abs((await cursorCenter()) - 300)).toBeLessThan(2)
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setCursor(window.harness.onsets().at(-1)!, { smooth: false })
    s.flushNow()
  })
  expect(await cursorCenter()).toBeCloseTo(300, 0)
  const content = await page.evaluate(() => {
    const l = window.harness.layout()!
    const tx = Number(
      /translate3d\((-?[\d.]+)px/.exec((document.querySelector('.pn-content') as HTMLElement).style.transform)![1],
    )
    return { tx, lastNoteX: l.notes.at(-1)!.x }
  })
  expect(content.tx + content.lastNoteX).toBeCloseTo(300, 0)
})

test('ctrl+wheel zoom scales the notation and keeps the current event in place', async ({ page }) => {
  await setup(page, 'long-500')
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setCursor(window.harness.onsets()[200]!, { smooth: false })
    s.flushNow()
  })
  const before = await rect(page, '.pn-cursor')
  const host = await rect(page, '#strip-host')
  await page.mouse.move(host.x + 500, host.y + 150)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await page.evaluate(() => window.harness.strip()!.flushNow())
  const zoom = await page.evaluate(() => window.harness.strip()!.zoom())
  expect(zoom).toBeGreaterThan(1.1)
  const after = await rect(page, '.pn-cursor')
  expect(Math.abs(after.x + after.width / 2 - (before.x + before.width / 2))).toBeLessThan(3)
})

test('dragging browses while enabled and Return to current position comes back', async ({ page }) => {
  await setup(page, 'long-500')
  await page.evaluate(() => window.harness.strip()!.setBrowseEnabled(true))
  const host = await rect(page, '#strip-host')
  const tx = () =>
    page.evaluate(() =>
      Number(
        /translate3d\((-?[\d.]+)px/.exec((document.querySelector('.pn-content') as HTMLElement).style.transform)![1],
      ),
    )
  const start = await tx()
  await page.mouse.move(host.x + 700, host.y + 200)
  await page.mouse.down()
  await page.mouse.move(host.x + 400, host.y + 200, { steps: 6 })
  await page.mouse.move(host.x + 100, host.y + 200, { steps: 6 })
  await page.mouse.up()
  await page.evaluate(() => window.harness.strip()!.flushNow())
  expect(await tx()).toBeLessThan(start - 500)
  const ret = page.getByRole('button', { name: 'Return to current position' })
  await expect(ret).toBeVisible()
  await ret.click()
  // The return releases the pinned opening, so it glides frame by frame and lands a moment later.
  await expect.poll(tx).toBe(start)
  const browse = await page.evaluate(() => window.harness.events.filter((e) => e.type === 'browse').map((e) => e.value))
  expect(browse).toEqual([true, false])
})

test('passage handles drag to barlines, never invert, and the clear button removes the passage', async ({ page }) => {
  await setup(page, 'long-500', { width: 1100, height: 380 })
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setLoop({ fromOcc: 0, toOcc: 0 })
    s.flushNow()
  })
  const occ = await page.evaluate(() =>
    window.harness
      .layout()!
      .occurrences.slice(0, 12)
      .map((o) => [o.x0, o.x1] as const),
  )
  const host = await rect(page, '#strip-host')
  const tx = await page
    .locator('.pn-content')
    .evaluate((el) => Number(/translate3d\((-?[\d.]+)px/.exec((el as HTMLElement).style.transform)![1]))
  // Furthest measure whose right barline is still on screen.
  const k = occ.findLastIndex(([, x1]) => tx + x1 < host.width - 30)
  expect(k).toBeGreaterThan(0)
  const drag = async (name: RegExp, toX: number) => {
    const b = (await page.getByRole('button', { name }).boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(host.x + toX, b.y + b.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.evaluate(() => window.harness.strip()!.flushNow())
  }
  await drag(/Passage end/, tx + occ[k]![1] - 10)
  await drag(/Passage start/, tx + occ[k]![1] - 5)
  const loops = await page.evaluate(() => window.harness.events.filter((e) => e.type === 'loop').map((e) => e.value))
  expect(loops).toEqual([
    { fromOcc: 0, toOcc: k },
    { fromOcc: k, toOcc: k },
  ])
  await expect.poll(async () => (await rect(page, '.pn-loop')).x - host.x).toBeCloseTo(tx + occ[k]![0], 0)
  await page.getByRole('button', { name: 'Clear passage selection' }).click({ force: true })
  const last = await page.evaluate(() => window.harness.events.filter((e) => e.type === 'loop').at(-1)!.value)
  expect(last).toBeNull()
  await page.evaluate(() => window.harness.strip()!.flushNow())
  await expect(page.locator('.pn-loop')).not.toHaveClass(/pn-on/)
})

test('labels fade by opacity on their own noteheads and are removed at zero', async ({ page }) => {
  await setup(page, 'basic')
  const first = await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setLabels(window.harness.labelTexts())
    s.setLabelOpacity(
      new Map([
        [0, 1],
        [1, 1],
      ]),
    )
    s.flushNow()
    const el = document.querySelector('.pn-label') as SVGTextElement
    return { text: el.textContent, x: el.getAttribute('x'), visible: s.visibleLabels() }
  })
  expect(first.visible).toEqual([0, 1])
  for (const o of [0.6, 0.2]) {
    const state = await page.evaluate((op) => {
      const s = window.harness.strip()!
      s.setLabelOpacity(
        new Map([
          [0, op],
          [1, 1],
        ]),
      )
      s.flushNow()
      const el = document.querySelector('.pn-label') as SVGTextElement
      return { opacity: getComputedStyle(el).opacity, x: el.getAttribute('x'), text: el.textContent }
    }, o)
    expect(Number(state.opacity)).toBeCloseTo(o, 2)
    expect(state.x).toBe(first.x)
    expect(state.text).toBe(first.text)
  }
  const remaining = await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setLabelOpacity(new Map([[1, 1]]))
    s.flushNow()
    return document.querySelectorAll('.pn-label').length
  })
  expect(remaining).toBe(1)
})

test('ottava emphasis holds steadily and clears', async ({ page }) => {
  await setup(page, 'ottava')
  await page.evaluate(() => {
    const s = window.harness.strip()!
    const l = window.harness.layout()!
    s.setCursor(l.occurrences[1]!.start, { smooth: false })
    s.setOttavaEmphasis([0])
    s.flushNow()
  })
  await expect(page.locator('.pn-ott-box')).toHaveClass(/pn-on/)
  const alert = await page.evaluate(() => getComputedStyle(document.querySelector('.pn-ott-box')!).borderTopColor)
  // Fill and stroke fade in over --pn-fast: poll until the transition has settled.
  const colors = () =>
    page
      .locator('.pn-music [data-o="0"]')
      .evaluateAll((els) =>
        els.map((el) => (el.localName === 'text' ? getComputedStyle(el).fill : getComputedStyle(el).stroke)),
      )
  expect((await colors()).length).toBeGreaterThan(0)
  await expect.poll(async () => (await colors()).every((c) => c === alert)).toBe(true)
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setOttavaEmphasis([])
    s.flushNow()
  })
  await expect(page.locator('.pn-ott-box')).not.toHaveClass(/pn-on/)
})

test('mounted notation contains no script, foreignObject, handlers or external references', async ({ page }) => {
  await setup(page, 'changes')
  await page.evaluate(() => {
    window.harness.showAllLabels()
  })
  const bad = await page.evaluate(() => {
    const root = document.querySelector('.pn-strip')!
    const out: string[] = []
    for (const el of root.querySelectorAll('*')) {
      if (/^(script|foreignObject|iframe|image|use|a)$/i.test(el.localName)) out.push(el.localName)
      for (const a of el.attributes)
        if (/^on/i.test(a.name) || /^(href|xlink:href)$/i.test(a.name)) out.push(`${el.localName}@${a.name}`)
    }
    return out
  })
  expect(bad).toEqual([])
})

test('the fixed signatures share the staff lines and notes fade at the stage edge', async ({ page }, info) => {
  await setup(page, 'changes')
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setCursor(window.harness.layout()!.occurrences[2]!.start, { smooth: false })
    s.flushNow()
  })
  await expect(page.locator('.pn-sticky')).toHaveClass(/pn-on/)
  await expect(page.locator('.pn-context-staff path')).toHaveCount(10)
  const styles = await page.evaluate(() => ({
    divider: getComputedStyle(document.querySelector('.pn-sticky-inner')!).boxShadow,
    fade: getComputedStyle(document.querySelector('.pn-stage')!).maskImage,
    cursorMotion: getComputedStyle(document.querySelector('.pn-cursor')!).transitionProperty,
  }))
  expect(styles.divider).toBe('none')
  expect(styles.fade).toContain('linear-gradient')
  expect(styles.cursorMotion).not.toBe('transform')
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((theme) => window.harness.setTheme(theme), theme)
    const path = info.outputPath(`stage-${theme}.png`)
    await page.locator('#strip-host').screenshot({ path })
    await info.attach(`stage-${theme}.png`, { path, contentType: 'image/png' })
  }
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`opening clefs stay visible as they pin and release on a tablet (${reducedMotion})`, async ({ page }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await page.emulateMedia({ reducedMotion })
    await setup(page, 'long-500', { width: 1194, height: 500 })
    const frames = await page.evaluate(async () => {
      const strip = window.harness.strip()!
      const layout = window.harness.layout()!
      const root = document.querySelector('.pn-strip')!
      const sticky = root.querySelector('.pn-sticky-inner')!
      const staff = root.querySelector('.pn-sticky-staff')!
      const stage = root.querySelector('.pn-stage')!
      const clefs = [...sticky.querySelectorAll('.vf-clef')]
      const original = [...stage.querySelectorAll('.pn-opening-signature.vf-clef')]
      const matrix = new DOMMatrixReadOnly(getComputedStyle(root.querySelector('.pn-content')!).transform)
      const edge = root.getBoundingClientRect().left
      // The hidden engraved clefs ride with the music: where the pinned ones belong on every frame.
      const sample = () => ({
        x: clefs.map((clef) => clef.getBoundingClientRect().left - edge),
        engraved: original.map((clef) => clef.getBoundingClientRect().left - edge),
        offset: sticky.getBoundingClientRect().left - edge,
        visible: clefs.every((clef) => getComputedStyle(clef).visibility === 'visible'),
        mask: parseFloat(getComputedStyle(stage).maskPosition),
        staffMask: parseFloat(getComputedStyle(staff).maskPosition),
      })
      const begin = sample()
      const originalsHidden = original.every((clef) => getComputedStyle(clef).visibility === 'hidden')
      const pinAt = root.getBoundingClientRect().width / 3 / matrix.a + layout.contextChanges[0]!.openingX!
      const next = layout.occurrences
        .flatMap((o) => o.anchors.slice(0, -1).map(([offset, x]) => ({ position: o.start + offset, x })))
        .find(({ x }) => x > pinAt + 20)!
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
      // A smooth seek, sampled after the strip's own work on every frame until well after it lands.
      const glide = async (position: number) => {
        strip.setCursor(position)
        const out: ReturnType<typeof sample>[] = []
        for (let i = 0; i < 24; i++) {
          await frame()
          out.push(sample())
        }
        return out
      }
      const forward = await glide(next.position)
      strip.setCursor(next.position + 0.25, { smooth: false })
      strip.flushNow()
      const later = sample()
      const back = await glide(0)
      return { begin, originalsHidden, fade: 32 * matrix.a, forward, later, back }
    })

    const { begin, forward, back } = frames
    const pinned = forward.at(-1)!
    expect(begin.x).toHaveLength(2)
    expect(begin.engraved).toHaveLength(2)
    expect(frames.originalsHidden).toBe(true)
    expect(begin.mask).toBeLessThan(0)
    expect(pinned.mask).toBe(0)
    expect(frames.later.x).toEqual(pinned.x)
    expect(frames.later.mask).toBe(0)
    expect(back.at(-1)!.mask).toBe(begin.mask)
    for (const [index, start] of begin.x.entries()) {
      expect(start).toBeCloseTo(begin.engraved[index]!, 1)
      expect(pinned.x[index]).toBeGreaterThan(0)
      expect(pinned.x[index]).toBeLessThan(10)
      expect(back.at(-1)!.x[index]).toBeCloseTo(start, 1)
    }
    // Every frame of both glides: each clef at max(its pinned place, its engraved place), the stage
    // and staff masks slid by the same clamped offset (fully slid away a fade's width from the edge).
    for (const run of [forward, back]) {
      for (const f of run) {
        for (const [index, x] of f.x.entries()) {
          expect(Math.abs(x - Math.max(pinned.x[index]!, f.engraved[index]!))).toBeLessThan(2)
        }
        expect(Math.abs(f.mask - begin.mask * Math.min(1, Math.max(0, f.offset) / frames.fade))).toBeLessThan(1)
        expect(f.staffMask).toBeCloseTo(f.mask, 1)
        expect(f.visible).toBe(true)
      }
    }
    // The glide shows the block on its way (pin and release); Reduced Motion lands at once.
    const between = (run: typeof forward) =>
      run.filter((f) => f.x[0]! > pinned.x[0]! + 2 && f.x[0]! < begin.x[0]! - 2).length
    if (reducedMotion === 'no-preference') {
      expect(between(forward)).toBeGreaterThan(0)
      expect(between(back)).toBeGreaterThan(0)
    } else {
      expect(between(forward)).toBe(0)
      expect(between(back)).toBe(0)
      expect(forward[0]!.x).toEqual(pinned.x)
    }
  })
}

test('fixed signatures and their fade stay clear of the cursor at 360 px while zooming', async ({ page }) => {
  await setup(page, 'changes', { width: 360, height: 360 })
  const geometry = await page.evaluate(() => {
    const s = window.harness.strip()!
    const l = window.harness.layout()!
    s.setCursor(l.occurrences.at(-1)!.start, { smooth: false })
    s.setZoom(2)
    s.flushNow()
    const root = document.querySelector('.pn-strip')!.getBoundingClientRect()
    const cursor = document.querySelector('.pn-cursor')!.getBoundingClientRect()
    const context = document.querySelector('.pn-sticky-inner')!.getBoundingClientRect()
    return {
      cursor: cursor.x - root.x,
      contextRight: context.right - root.x,
      fadeEnd: (Math.max(...l.contexts.map((c) => c.width)) + 32) * s.zoom(),
    }
  })
  expect(geometry.cursor).toBeCloseTo(120, 1)
  expect(geometry.contextRight).toBeLessThan(geometry.cursor - 20)
  expect(geometry.fadeEnd).toBeLessThanOrEqual(geometry.cursor - 12 + 0.01)
})
