import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as playwright from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { connectBrowserTarget, selectBrowserTarget } from './browser-target.ts';

const [endpoint, scriptPath, artifactsDir, parametersJSON = '{}', targetId] = process.argv.slice(2);
const report: { result: unknown; error?: string; url?: string; title?: string; screenshotPath?: string } = { result: null };
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

try {
  assert.ok(endpoint && targetId && scriptPath && artifactsDir, 'Browser endpoint, target ID, script path and artifacts directory are required');
  assert.ok(process.permission, 'Script runner requires Node --permission');
  const parameters = JSON.parse(parametersJSON);
  browser = await connectBrowserTarget(endpoint, targetId, { artifactsDir });
  ({ context, page } = await selectBrowserTarget(browser, targetId));
  assert.ok(context, 'The browser has no default context');
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(20_000);

  // ponytail: retain the existing browser socket; generated scripts need no new Node sockets.
  process.permission.drop('net');
  const run = (await import(pathToFileURL(scriptPath).href)).default;
  assert.equal(typeof run, 'function', 'Script must export a default function');
  const result = await run({ page, context, browser, playwright, artifactsDir, parameters, assert });
  const serialized = JSON.stringify(result, (_key, value) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('Script result must contain only JSON values');
    }
    return value;
  });
  report.result = JSON.parse(serialized);
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    if (page && !page.isClosed()) {
      report.url = page.url();
      const screenshotPath = join(artifactsDir, 'screenshot.png');
      const [title, screenshot] = await Promise.allSettled([
        Promise.race([page.title(), delay(3_000, undefined, { ref: false })]),
        page.screenshot({ path: screenshotPath, type: 'png', timeout: 3_000 }),
      ]);
      if (title.status === 'fulfilled' && typeof title.value === 'string') report.title = title.value;
      if (screenshot.status === 'fulfilled') report.screenshotPath = screenshotPath;
    }
  } catch {}
  try {
    writeSync(3, `${JSON.stringify(report)}\n`);
  } catch (error) {
    console.error('Could not report script result:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // Closing a CDP connection disconnects this client; the host retains its browser and pages.
    await browser?.close().catch(() => {});
  }
}
