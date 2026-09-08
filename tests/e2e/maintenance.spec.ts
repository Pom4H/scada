import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => !!(window as any).__scada);
});

test('parameter edits retain SVG nodes, routing and the paused rotor phase', async ({ page }) => {
  await page.locator('[data-node="P-101"]').click();
  const rotor = page.locator('[data-node="P-101"] [data-part="rotor"]');
  const first = await rotor.getAttribute('transform');
  await expect.poll(() => rotor.getAttribute('transform')).not.toBe(first);
  await page.locator('#pause').click();
  const phase = await rotor.getAttribute('transform');
  await page.evaluate(() => {
    (window as any).__rotorProbe = document.querySelector('[data-node="P-101"] [data-part="rotor"]');
    (window as any).__pipeProbe = document.querySelector('[data-water]');
  });
  await page.locator('#field-temperature').fill('85');
  await page.locator('#field-temperature').press('Tab');
  expect(await page.evaluate(() =>
    (window as any).__rotorProbe === document.querySelector('[data-node="P-101"] [data-part="rotor"]') &&
    (window as any).__pipeProbe === document.querySelector('[data-water]')
  )).toBe(true);
  expect(await rotor.getAttribute('transform')).toBe(phase);
  expect(await page.evaluate(() => (window as any).__scada.source)).toContain('temperature: 85');
  await page.locator('#pause').click();
  await expect.poll(() => rotor.getAttribute('transform')).not.toBe(phase);
});

test('quality changes suppress fabricated water and keep the equipment ID legible', async ({ page }) => {
  await page.locator('[data-node="P-101"]').click();
  await page.locator('#field-quality').selectOption('bad');
  await expect(page.locator('[data-node="P-101"]')).toHaveAttribute('data-quality', 'bad');
  await expect(page.locator('[data-flow]').first()).toHaveAttribute('opacity', '0');
  await expect(page.locator('#flow-readout')).toHaveText('—');
  await expect(page.locator('[data-water]').first()).toHaveAttribute('stroke', '#b5c8d1');
  const title = await page.locator('[data-node="P-101"] .object-label').boundingBox();
  const state = await page.locator('[data-node="P-101"] > text').boundingBox();
  expect(state!.y).toBeGreaterThan(title!.y + title!.height);
  await page.screenshot({ path: 'test-results/quality-bad.png' });
  await page.locator('#field-quality').selectOption('good');
  await expect(page.locator('[data-water]').first()).toHaveAttribute('stroke', '#08a7c5');
});

test('tank with unavailable data does not show a made-up fluid level', async ({ page }) => {
  await page.locator('[data-node="T-101"]').click();
  await page.locator('#field-quality').selectOption('bad');
  await expect(page.locator('[data-node="T-101"] [clip-path]')).toHaveAttribute('opacity', '0');
  await page.locator('#field-quality').selectOption('good');
  await expect(page.locator('[data-node="T-101"] [clip-path]')).toHaveAttribute('opacity', '1');
});

test('changing coordinates still reroutes after parameter-only updates', async ({ page }) => {
  await page.locator('[data-node="V-101"]').click();
  await page.locator('#field-opening').fill('0');
  await page.locator('#field-opening').press('Tab');
  const before = await page.locator('[data-water]').nth(2).getAttribute('d');
  await page.locator('#field-y').fill('220');
  await page.locator('#field-y').press('Tab');
  expect(await page.locator('[data-water]').nth(2).getAttribute('d')).not.toBe(before);
  expect(await page.evaluate(() => (window as any).__scada.flows['F-101'])).toBe(0);
  await page.locator('#field-opening').fill('100');
  await page.locator('#field-opening').press('Tab');
  expect(await page.evaluate(() => (window as any).__scada.flows['F-101'])).toBe(12);
});
