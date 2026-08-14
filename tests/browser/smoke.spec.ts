import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
})

test('loads assets, exposes the command boundary, and responds to controls', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  await expect(page).toHaveTitle(/Wildmarch/)
  await expect(page.locator('#loading')).toHaveClass(/done/)
  await expect(page.locator('#vitals')).toContainText('Wildmarch')
  await expect(page.locator('#autobtn')).toBeVisible()

  if ((page.viewportSize()?.width ?? 1000) <= 860) {
    await page.locator('#chrome-toggle').click()
  }
  const before = await page.evaluate(() => window.__wildmarch!.snapshot().player.auto)
  await page.locator('#autobtn').click()
  await expect.poll(() => page.evaluate(() => window.__wildmarch!.snapshot().player.auto)).toBe(!before)
  expect(await page.evaluate(() => ({ oldGame: '__game' in window, oldRenderer: '__renderer' in window })))
    .toEqual({ oldGame: false, oldRenderer: false })

  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}.png`), animations: 'disabled' })
  expect(errors).toEqual([])
})

test('opens the inventory surface and preserves the six-slot model', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#loading')).toHaveClass(/done/)
  if (!(await page.locator('#panel').getAttribute('class'))?.includes('open')) {
    await page.getByRole('button', { name: /Bag/ }).click()
  }
  await expect(page.locator('#panel')).toHaveClass(/open/)
  await expect(page.locator('.equip-grid .slot')).toHaveCount(6)
  if ((page.viewportSize()?.width ?? 1000) <= 860) {
    const height = await page.locator('#panel').evaluate((node) => node.getBoundingClientRect().height)
    expect(height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 1000) * 0.58 + 2)
  }
  await page.screenshot({ path: test.info().outputPath(`${test.info().project.name}-inventory.png`), animations: 'disabled' })
})

test('persists a strict save and applies offline progression after reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-concept')
  await page.goto('/')
  await expect(page.locator('#loading')).toHaveClass(/done/)
  const serialized = await page.evaluate(() => {
    const simulation = window.__wildmarch!.simulation
    simulation.player.gold = 123
    simulation.setHuntingGround('vale')
    const save = simulation.serialize()
    save.savedAt = Date.now() - 60 * 60 * 1000
    return JSON.stringify(save)
  })
  // Install after the current page's pagehide autosave, but before the new app
  // boots. This mirrors returning to an already aged, valid local save.
  await page.addInitScript((save) => localStorage.setItem('wildmarch.ecs.save.v1', save), serialized)
  await page.reload()
  await expect(page.locator('#loading')).toHaveClass(/done/)
  await expect.poll(() => page.evaluate(() => window.__wildmarch!.snapshot().player.gold)).toBeGreaterThanOrEqual(123)
  await expect(page.locator('#report')).toHaveClass(/show/)
  await expect.poll(() => page.evaluate(() => window.__wildmarch!.snapshot().counters.kills)).toBeGreaterThan(0)
})

test('supports mobile thumbstick, chrome collapse, and reduced motion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.locator('#loading')).toHaveClass(/done/)

  await page.locator('#chrome-toggle').click()
  await expect(page.locator('#nav')).toBeHidden()
  await expect(page.locator('#panel')).toBeHidden()

  const zone = page.locator('#stickzone')
  const box = await zone.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 80, box!.y + box!.height * 0.55)
  await page.mouse.down()
  await expect(page.locator('#stick')).toHaveClass(/live/)
  await page.mouse.move(box!.x + 120, box!.y + box!.height * 0.55)
  await page.mouse.up()
  await expect(page.locator('#stick')).not.toHaveClass(/live/)

  await expect(page.locator('#nav')).toBeHidden()
  await expect(page.locator('#panel')).toBeHidden()
  await expect(page.locator('#chrome-toggle')).toHaveAttribute('aria-label', /Expand/)
  const duration = await page.locator('#panel').evaluate((node) => parseFloat(getComputedStyle(node).transitionDuration))
  expect(duration).toBeLessThanOrEqual(0.000_001)
})
