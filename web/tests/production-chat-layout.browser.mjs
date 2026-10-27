// Build with VITE_APP_EDITION=operations, then serve with `npm run preview`.
import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "../../desktop/runtime/node_modules/playwright-core/index.mjs"

test("production chat preserves centered columns and Arc spacing after CSS splitting", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 1462, height: 919 },
    reducedMotion: "reduce",
  })
  await page.goto(
    process.env.OMNIOPS_WEB_PREVIEW_URL ?? "http://127.0.0.1:4173/"
  )
  assert.equal(
    await page.locator('script[src="/@vite/client"]').count(),
    0,
    "This regression must run against production CSS, not Vite development styles"
  )
  await page
    .getByRole("textbox", { name: "消息输入" })
    .fill("请说明当前工作区的检查步骤。")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  await viewport.waitFor()

  async function checkColumn() {
    const metrics = await viewport.evaluate((scroller) => {
      const thread = scroller.firstElementChild
      const composer = document.querySelector(
        '[data-slot="chat-composer-anchor"]'
      )
      const bounds = thread.getBoundingClientRect()
      const outer = scroller.getBoundingClientRect()
      const input = composer.getBoundingClientRect()
      const style = getComputedStyle(thread)
      return {
        centered: Math.abs(
          bounds.x + bounds.width / 2 - outer.x - outer.width / 2
        ),
        inputAxis: Math.abs(
          bounds.x + bounds.width / 2 - input.x - input.width / 2
        ),
        padding: parseFloat(style.paddingLeft),
        width: bounds.width,
        overflow: scroller.scrollWidth - scroller.clientWidth,
      }
    })
    assert.ok(metrics.centered <= 1, JSON.stringify(metrics))
    assert.ok(metrics.inputAxis <= 1, JSON.stringify(metrics))
    assert.ok(
      metrics.padding >= 16,
      "Preflight must not reset Arc message padding"
    )
    assert.ok(metrics.width <= 816, "Messages must keep their readable column")
    assert.ok(
      metrics.overflow <= 1,
      "Messages must fit the available chat width"
    )
  }

  await checkColumn()
  await page.getByRole("button", { name: "打开工作台", exact: true }).click()
  await checkColumn()
  await page.getByRole("button", { name: "收起工作台", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await checkColumn()
})
