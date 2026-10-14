import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const MODEL_CODE = /src\/llm\.ts|web-llm|mlc-ai|huggingface/

/** Collects console errors, uncaught exceptions and any request for model code. */
function watch(page: Page) {
  const errors: string[] = []
  const modelRequests: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (MODEL_CODE.test(request.url())) modelRequests.push(request.url())
  })
  return { errors, modelRequests }
}

async function say(page: Page, text: string) {
  const line = page.getByRole('textbox', { name: 'Your reply' })
  await expect(line).toBeEnabled()
  await line.fill(text)
  await line.press('Enter')
}

test('a full round without the AI, from the start screen to a shared scorecard', async ({ page, browser }) => {
  const seen = watch(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Haggle', level: 1 })).toBeVisible()
  await page.getByRole('radio', { name: /Marcus/ }).check()
  await page.getByRole('button', { name: 'Play without the AI (no download)' }).click()

  const log = page.locator('#log')
  await expect(log).toContainText('I can do $1,800')

  await say(page, 'Okay, I could do $3,800.')
  await expect(page.locator('#offers li').last()).toHaveText('$1,800')
  await say(page, 'I can do $3,600 if you pay a 50% deposit upfront.')
  await expect(page.locator('#offers li').last()).toHaveText('$2,200')
  await say(page, 'My price is firm at $3,600.')
  await expect(page.locator('#offers li').last()).toHaveText('$2,600')

  // The tape strikes through every price the player gave up.
  await expect(page.locator('#yourprices li.gone')).toHaveText(['$4,000', '$3,800'])
  await expect(page.locator('#yourprices li').last()).toHaveText('$3,600')

  await say(page, "If that's your budget, I don't think I'm the right fit.")
  await expect(page.locator('#offers li').last()).toHaveText('$3,400')
  await say(page, "Alright, I'll take your offer.")

  // The round ends: the limit is stamped and the receipt appears.
  await expect(page.locator('#limit')).toHaveText("Marcus's real limit: $3,400")
  const receipt = page.locator('#end')
  await expect(receipt).toBeVisible()
  await expect(page.locator('#score')).toHaveText('88')
  await expect(page.locator('#grade')).toHaveText('Held the line')
  await expect(page.locator('#worstquote')).toHaveText('Okay, I could do $3,800.')
  await expect(page.locator('#moments li')).toHaveCount(5)
  await expect(page.getByRole('textbox', { name: 'Your reply' })).toBeHidden()

  // The share link opens the same card on a fresh page.
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.locator('#copied')).toContainText('Link copied')
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link).toMatch(/#card=/)

  const fresh = await browser.newPage()
  const freshSeen = watch(fresh)
  await fresh.goto(link)
  await expect(fresh.getByRole('heading', { name: 'A round against Marcus' })).toBeVisible()
  await expect(fresh.locator('#score')).toHaveText('88')
  await expect(fresh.locator('#worstquote')).toHaveText('Okay, I could do $3,800.')
  await expect(fresh.getByRole('button', { name: 'Play your own round' })).toBeVisible()
  await fresh.waitForLoadState('networkidle')

  expect(seen.errors).toEqual([])
  expect(freshSeen.errors).toEqual([])
  expect(seen.modelRequests).toEqual([])
  expect(freshSeen.modelRequests).toEqual([])
  await fresh.close()
})

test('each client can be picked and plays its own numbers', async ({ page }) => {
  const seen = watch(page)
  await page.goto('/')
  await page.getByRole('radio', { name: /Viktor/ }).check()
  await page.getByRole('button', { name: 'Play without the AI (no download)' }).click()
  await expect(page.locator('#theirlabel')).toHaveText("Viktor's offer")
  await expect(page.locator('#offers li').last()).toHaveText('$2,600')
  await say(page, 'My price is firm at $4,000.')
  await expect(page.locator('#offers li').last()).toHaveText('$2,850')
  expect(seen.errors).toEqual([])
})

test('a broken share link falls back to the start screen', async ({ page }) => {
  const seen = watch(page)
  await page.goto('/#card=not-a-card')
  await expect(page.locator('#end')).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Who are you quoting?' })).toBeVisible()
  expect(seen.errors).toEqual([])
})
