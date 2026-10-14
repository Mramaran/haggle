// Runs the four-round play-test against the real model in Edge, using the GPU, and waits
// for it to finish. The page saves its results to output/spike/ through the dev server.
//
// Usage: node scripts/ai-playtest.mjs <edge profile dir> [model id]
// Needs the dev server on http://localhost:5173 (npm run dev).

import { chromium } from '@playwright/test'

const [profile, model = 'gemma-2-2b-it-q4f16_1-MLC'] = process.argv.slice(2)
if (!profile) {
  console.error('Usage: node scripts/ai-playtest.mjs <edge profile dir> [model id]')
  process.exit(2)
}

const headless = process.env.HEADLESS === '1'
const context = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless,
  args: ['--enable-unsafe-webgpu'],
  viewport: { width: 1100, height: 800 },
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('pageerror', (error) => console.log('page error:', error.message))

await page.goto('http://localhost:5173/spike.html')
const gpu = await page.evaluate(async () => {
  if (!('gpu' in navigator)) return 'no WebGPU'
  const adapter = await navigator.gpu.requestAdapter()
  return adapter ? `adapter ok, shader-f16: ${adapter.features.has('shader-f16')}` : 'no adapter'
})
console.log(`WebGPU (${headless ? 'headless' : 'headed'}): ${gpu}`)
if (!gpu.startsWith('adapter ok')) {
  await context.close()
  process.exit(3)
}

// Mode "game": play one round through the real game page, as a person would, and keep a screenshot.
if (process.argv[4] === 'game') {
  const lines = [
    'I understand budgets are tight, but $4,000 is what this work costs.',
    'Okay, I could do $3,800.',
    'I can do $3,600 if you pay a 50% deposit upfront.',
    "What's your real budget?",
    "If that's your budget, I don't think I'm the right fit.",
    "Alright, I'll take your offer.",
  ]
  await page.goto(`http://localhost:5173/?debug&model=${model}`)
  await page.getByRole('radio', { name: /Marcus/ }).check()
  await page.getByRole('button', { name: 'Start negotiating' }).click()
  const reply = page.getByRole('textbox', { name: 'Your reply' })
  const started = Date.now()
  await reply.waitFor({ state: 'visible', timeout: 15 * 60 * 1000 })
  await page.waitForFunction(() => !document.querySelector('#line')?.hasAttribute('disabled'), null, { timeout: 15 * 60 * 1000 })
  console.log(`opening reply after ${Math.round((Date.now() - started) / 1000)}s`)
  for (const line of lines) {
    if (!(await page.locator('#end').isHidden())) break
    const sent = Date.now()
    await reply.fill(line)
    await reply.press('Enter')
    await page.waitForFunction(
      () => !document.querySelector('#line')?.hasAttribute('disabled') || !document.querySelector('#end')?.hasAttribute('hidden'),
      null,
      { timeout: 120_000 },
    )
    console.log(`turn took ${Math.round((Date.now() - sent) / 100) / 10}s`)
  }
  console.log('\n--- chat ---\n' + (await page.locator('#log').innerText()))
  console.log('\n--- tape ---\n' + (await page.locator('.tape').innerText()))
  console.log('\n--- receipt ---\n' + (await page.locator('#end').innerText()))
  await page.screenshot({ path: process.argv[5] ?? 'game-ai.png', fullPage: true })
  await context.close()
  process.exit(0)
}

await page.goto(`http://localhost:5173/spike.html?rounds=1&auto=1&model=${model}`)
let last = ''
const started = Date.now()
const limitMs = 20 * 60 * 1000
while (Date.now() - started < limitMs) {
  const status = await page.locator('#status').textContent()
  if (status !== last) {
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${status}`)
    last = status ?? ''
  }
  if (status?.startsWith('FINISHED') || status?.startsWith('Failed')) break
  await page.waitForTimeout(5000)
}
console.log((await page.locator('#summary').textContent()) ?? '')
await context.close()
