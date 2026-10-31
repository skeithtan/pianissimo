/** Spec "Deferred assets": opening the library must not load the notation engine. */
import { expect, test } from '@playwright/test'

test('the app shell does not fetch the notation engine', async ({ page }) => {
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))
  await page.goto('./')
  await page.waitForLoadState('networkidle')
  expect(requested.filter((u) => /opensheetmusicdisplay|osmd|vexflow/i.test(u))).toEqual([])
})
