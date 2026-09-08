import { test, expect, type Page } from '@playwright/test';
import { booster } from '../../src/examples';
import { nestedTap, stackedTaps } from '../fixtures';

const start = new Date('2026-09-08T12:00:00Z');
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: start });
  await page.goto('./');
  await page.waitForFunction(() => !!(window as any).__scada);
  await page.clock.pauseAt(new Date(start.getTime() + 60_000));
});
const setSource = async (page: Page, source: string) => {
  await page.evaluate(source => {
    (window as any).__scada.setSource(source); (window as any).__scada.fit();
  }, source);
  // Let the 100 ms readout refresh run before capturing evidence.
  await page.clock.runFor(160);
};
const click = (page: Page, id: string) => page.locator(`#${id}`).evaluate((node: HTMLElement) => node.click());

test('B01 deleting a nested tap in the inspector preserves its visible pipe', async ({ page }, info) => {
  await setSource(page, nestedTap);
  await page.evaluate(() => (window as any).__scada.select('PT'));
  await page.screenshot({ path: info.outputPath('before-delete.png') });
  await click(page, 'delete-object');
  await page.screenshot({ path: info.outputPath('after-delete.png') });
  expect(await page.locator('[data-edge]').count()).toBe(1);
});

test('B02 instrument collisions cannot be silently declared warning-free', async ({ page }, info) => {
  await setSource(page, stackedTaps);
  const positions = await page.evaluate(() => ['PT', 'TT'].map(id => document.querySelector(`[data-node="${id}"]`)!.getAttribute('transform')));
  expect(positions[0]).toBe(positions[1]);
  await page.screenshot({ path: info.outputPath('stacked-taps.png') });
  const warnings = await page.evaluate(() => (window as any).__scada.warnings as string[]);
  expect(warnings.some(w => w.includes('PT') && w.includes('TT'))).toBe(true);
});

test('B03 switching to another circuit starts a new trend history', async ({ page }, info) => {
  await page.clock.runFor(1300);
  const before = await page.locator('#trend path').getAttribute('d');
  expect(before).toContain('L');
  // Use the actual project picker and its confirmation, not a model mutation.
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#examples').selectOption('twin');
  await page.clock.runFor(600);
  await expect(page.locator('#flow-readout')).toHaveText('+12.0');
  const after = await page.locator('#trend path').getAttribute('d');
  await info.attach('trend-paths', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('mixed-trend.png') });
  // Every surviving point must belong to the new +12 m³/h channel.
  // Accept one or several new samples; reject the old +9.12 m³/h points.
  const y = [...after!.matchAll(/[ML][-\d.]+ ([-\d.]+)/g)].map(m => Number(m[1]));
  expect(y.length).toBeGreaterThan(0);
  expect(y.every(value => Math.abs(value - 16.5) < .05)).toBe(true);
});

test('B04 resuming after a long preview pause leaves a gap in the sampled trend', async ({ page }, info) => {
  await page.clock.runFor(1300);
  await click(page, 'pause');
  await page.clock.runFor(10_000);
  await click(page, 'pause');
  await page.clock.runFor(600);
  const path = await page.locator('#trend path').getAttribute('d');
  await info.attach('trend-path', { body: path!, contentType: 'text/plain' });
  expect((path!.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test('B05 120 parameter updates keep DOM identity and signed water movement', async ({ page }) => {
  await page.clock.runFor(1000);
  await page.evaluate(source => {
    (window as any).__challengeRotor = document.querySelector('[data-part="rotor"]');
    (window as any).__challengePipe = document.querySelector('[data-flow]');
    for (let i = 0; i < 120; i++) (window as any).__scada.setSource(source.replace('rpm: 1500', `rpm: ${i % 2 ? -1500 : 1500}`));
  }, booster);
  const identity = await page.evaluate(() => (window as any).__challengeRotor === document.querySelector('[data-part="rotor"]') && (window as any).__challengePipe === document.querySelector('[data-flow]'));
  expect(identity).toBe(true);
  await page.clock.runFor(1000); // Allow signed visual RPM to settle.
  const before = await page.locator('[data-flow]').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('stroke-dashoffset'))));
  await page.clock.runFor(96);
  const after = await page.locator('[data-flow]').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('stroke-dashoffset'))));
  for (let i = 0; i < before.length; i++) expect((after[i] - before[i] + 66) % 66).toBeCloseTo(9.12 * 4.5 * .096, 1);
});

test('B06 loss of quality stops animation and creates a real trend gap', async ({ page }) => {
  await page.clock.runFor(1300);
  await setSource(page, booster.replace('rpm: 1500', 'rpm: 1500, quality: "bad"'));
  await page.clock.runFor(1200);
  await expect(page.locator('#flow-readout')).toHaveText('—');
  for (const opacity of await page.locator('[data-flow]').evaluateAll(nodes => nodes.map(n => n.getAttribute('opacity')))) expect(opacity).toBe('0');
  const rotor = await page.locator('[data-part="rotor"]').getAttribute('transform');
  await page.clock.runFor(300);
  expect(await page.locator('[data-part="rotor"]').getAttribute('transform')).toBe(rotor);
  await setSource(page, booster);
  await page.clock.runFor(1200);
  const path = await page.locator('#trend path').getAttribute('d');
  expect((path!.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2);
});
