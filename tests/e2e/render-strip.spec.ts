/**
 * StripView in real browsers (spec "Practice screen", ottava and wrong-key feedback, "Deferred
 * assets", "Live rendering isolation"): cursor placement, zoom, browsing, passage handles, label
 * fades, warnings, sanitization and lazy loading of the notation engine.
 */
import { expect, test, type Page } from '@playwright/test'
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
  await page.evaluate(() => window.harness.strip()!.flushNow())
  expect(await tx()).toBe(start)
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

test('wrong keys tint the cursor without text over notes; ottava emphasis holds steadily', async ({ page }) => {
  await setup(page, 'ottava')
  await page.evaluate(() => {
    const s = window.harness.strip()!
    const l = window.harness.layout()!
    s.setCursor(l.occurrences[1]!.start, { smooth: false })
    s.setOttavaEmphasis([0])
    s.pulseWrong()
    s.flushNow()
  })
  await expect(page.locator('.pn-wrong')).toHaveCount(0)
  await expect(page.locator('.pn-cursor')).toHaveClass(/pn-cursor-wrong/)
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
    s.pulseWrong()
    s.flushNow()
  })
  await expect(page.locator('.pn-cursor')).toHaveClass(/pn-cursor-wrong/)
  await page.evaluate(() => {
    const s = window.harness.strip()!
    s.setWrongMarker(false)
    s.setOttavaEmphasis([])
    s.flushNow()
  })
  await expect(page.locator('.pn-cursor')).not.toHaveClass(/pn-cursor-wrong/)
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
