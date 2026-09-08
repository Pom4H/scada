import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const url = process.env.PLAYGROUND_URL || 'https://pom4h.github.io/scada/';
await mkdir('live-check', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const api = () => page.evaluate(() => ({ source: window.__scada.source, flows: window.__scada.flows, error: window.__scada.error }));
const rotor = () => page.locator('[data-node="P-101"] [data-part="rotor"]').getAttribute('transform');
const water = () => page.locator('[data-flow]').first().getAttribute('stroke-dashoffset');
try {
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    status = response?.status() || 0; if (status === 200) break;
    await page.waitForTimeout(5000);
  }
  assert.equal(status, 200, 'Published HTML returns HTTP 200');
  await page.waitForFunction(() => !!window.__scada);
  assert.equal((await api()).error, null);
  assert.equal(await page.locator('[data-node]').count(), 8);
  const original = (await api()).source;
  const a = await rotor(), w = await water(); await page.waitForTimeout(300);
  assert.notEqual(await rotor(), a); assert.notEqual(await water(), w);
  const hit = await page.locator('[data-node="P-101"] .node-hit').boundingBox();
  const x = hit.x + hit.width * .7, y = hit.y + hit.height * .65;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 35, y + 25, { steps: 8 }); await page.mouse.up();
  assert.notEqual((await api()).source, original);
  await page.locator('#undo').click(); assert.equal((await api()).source, original);
  await page.locator('[data-node="V-101"]').click();
  await page.locator('#field-opening').fill('0'); await page.locator('#field-opening').press('Tab');
  assert.equal((await api()).flows['F-101'], 0);
  const stoppedWater = await water(), rotatingPump = await rotor(); await page.waitForTimeout(300);
  assert.equal(await water(), stoppedWater); assert.notEqual(await rotor(), rotatingPump);
  await page.screenshot({ path: 'live-check/valve-closed.png' });
  await page.locator('#field-opening').fill('76'); await page.locator('#field-opening').press('Tab');
  await page.waitForTimeout(300); await page.screenshot({ path: 'live-check/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-tab="canvas"]').click();
  await page.screenshot({ path: 'live-check/mobile.png' });
  await page.locator('[data-tab="inspect"]').click();
  await page.screenshot({ path: 'live-check/mobile-inspector.png' });
  assert.deepEqual(errors, []);
  const result = { url, status, passed: true, checks: ['HTML and assets', 'eight equipment elements', 'rotor animation', 'water animation', 'drag updates TypeScript', 'one undo restores source', 'closed valve stops flow', 'closed valve does not stop powered rotor', 'responsive panels', 'no page errors'] };
  await writeFile('live-check/result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: 'live-check/failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
