import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const { chromium } = createRequire(new URL('../../desktop/runtime/package.json', import.meta.url))('playwright-core');
const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

test('document comments work across chapters, reloads, narrow screens, and storage failures', { timeout: 60000 }, async () => {
  const server = createServer(async (request, response) => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const panel = page.locator('#document-comments'), input = page.getByLabel('记录本章意见');
    assert.equal(await panel.isVisible(), false);
    await page.getByRole('button', { name: '本章评论', exact: true }).click();
    await input.fill('总体意见 <img src=x onerror="window.commentInjected=true">');
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    assert.equal(await input.inputValue(), '');
    assert.equal(await panel.locator('.comment-entry').count(), 1);
    assert.equal(await panel.locator('.comment-text img').count(), 0);
    assert.equal(await page.evaluate(() => window.commentInjected), undefined);
    await page.reload();
    await page.getByRole('button', { name: '本章评论 · 1' }).click();
    await panel.getByRole('button', { name: /^编辑评论/ }).click();
    await page.getByLabel('编辑本章意见').fill('总体意见已修改');
    await page.getByRole('button', { name: '保存修改' }).click();
    assert.equal(await panel.locator('.comment-text').textContent(), '总体意见已修改');
    await panel.getByRole('button', { name: /^删除评论/ }).click();
    assert.equal(await panel.locator('.comment-entry').count(), 0);
    await page.getByRole('button', { name: '撤销删除' }).click();
    assert.equal(await panel.locator('.comment-entry').count(), 1);
    await page.locator('.chapter-nav a[href="#01-skill"]').click();
    assert.equal(await panel.locator('.comment-entry').count(), 0);
    await page.getByLabel('记录本章意见').fill('SKILL 章意见');
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出全部评论' }).click();
    const exported = await readFile(await (await downloadPromise).path(), 'utf8');
    assert.match(exported, /总体意见已修改/);
    assert.match(exported, /SKILL 章意见/);
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '关闭文档评论' }).click();
    await page.getByLabel('章节', { exact: true }).selectOption('09-operations');
    await page.locator('[id="09-operations"]').waitFor({ state: 'visible' });
    assert.match(await page.locator('article:not([hidden])').textContent(), /SQLite/);
    await page.getByRole('button', { name: '下一章', exact: true }).click();
    await page.locator('[id="10-server-api"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#progress').textContent(), '11 / 12');
    assert.equal(await page.locator('#next').isDisabled(), false);
    assert.match(await page.locator('article:not([hidden])').textContent(), /latest\.json/);
    await page.getByRole('button', { name: '下一章', exact: true }).click();
    await page.locator('[id="11-provider"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#progress').textContent(), '12 / 12');
    assert.equal(await page.locator('#next').isDisabled(), true);
    assert.equal(await page.locator('#source').getAttribute('href'), '11-Provider.md');
    assert.match(await page.locator('article:not([hidden])').textContent(), /操作系统凭据库/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '本章评论', exact: true }).click();
    await page.getByLabel('记录本章意见').fill('待保存草稿');
    await page.getByRole('button', { name: '关闭文档评论' }).click();
    await page.getByLabel('章节', { exact: true }).selectOption('01-skill');
    await page.getByLabel('章节', { exact: true }).selectOption('11-provider');
    await page.getByRole('button', { name: '本章评论', exact: true }).click();
    assert.equal(await page.getByLabel('记录本章意见').inputValue(), '待保存草稿');
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreCommentStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function (key, value) {
        if (key.includes('requirements-walkthrough:comments')) throw new Error('Quota exceeded');
        return original.call(this, key, value);
      };
    });
    await page.getByRole('button', { name: '保存评论', exact: true }).click();
    assert.equal(await page.getByLabel('编辑本章意见').inputValue(), '待保存草稿');
    assert.match(await panel.getByRole('status').textContent(), /保存失败/);
    assert.equal(await panel.locator('.comment-entry').count(), 1);
    const failedDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出全部评论' }).click();
    assert.match(await readFile(await (await failedDownload).path(), 'utf8'), /待保存草稿/);
    await page.getByRole('button', { name: '保存修改' }).click();
    assert.equal(await panel.locator('.comment-entry').count(), 1);
    await page.evaluate(() => window.restoreCommentStorage());
    await page.getByRole('button', { name: '保存修改' }).click();
    assert.equal(await page.getByLabel('记录本章意见').inputValue(), '');
    await page.reload();
    await page.getByRole('button', { name: '本章评论 · 1' }).click();
    assert.equal(await panel.locator('.comment-text').textContent(), '待保存草稿');
    if (process.env.WALKTHROUGH_SCREENSHOT_DIR) {
      await page.screenshot({ path: resolve(process.env.WALKTHROUGH_SCREENSHOT_DIR, 'comments-mobile.png') });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: resolve(process.env.WALKTHROUGH_SCREENSHOT_DIR, 'comments-desktop.png') });
    }
    assert.deepEqual(pageErrors, []);
    const localPage = await context.newPage();
    await localPage.goto(new URL('index.html', import.meta.url).href);
    await localPage.getByRole('button', { name: '本章评论', exact: true }).click();
    await localPage.getByLabel('记录本章意见').fill('直接打开本地文档也能记录');
    await localPage.getByRole('button', { name: '保存评论', exact: true }).click();
    await localPage.reload();
    await localPage.getByRole('button', { name: '本章评论 · 1' }).click();
    assert.equal(await localPage.locator('.comment-text').textContent(), '直接打开本地文档也能记录');
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
