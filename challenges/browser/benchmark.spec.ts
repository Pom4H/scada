import { test, expect } from '@playwright/test';
import { crowdedCircuit } from '../fixtures';

test('B07 measure geometry edits and parameter edits on a valid 48-element scene', async ({ page }, info) => {
  // Use a fresh page with native performance.now: no fake clock in this file.
  // Measure synchronous editor calls, not FPS or GPU performance.
  await page.goto('./');
  await page.waitForFunction(() => !!(window as any).__scada);
  const source = crowdedCircuit(48);
  const measures = await page.evaluate(source => {
    const api = (window as any).__scada;
    const times: { kind: string; ms: number }[] = [];
    let t = performance.now(); api.setSource(source); times.push({ kind: 'initial', ms: performance.now() - t });
    for (let i = 0; i < 3; i++) {
      const parameter = source.replace('pump("N1", {', `pump("N1", {rpm:${1000 + i * 100},`);
      t = performance.now(); api.setSource(parameter); times.push({ kind: 'parameter', ms: performance.now() - t });
    }
    const match = source.match(/const n1 = pump\("N1", \{"x":(\d+)/)!;
    for (let i = 1; i <= 3; i++) {
      const moved = source.replace(match[0], match[0].replace(/\d+$/, String(Number(match[1]) + i)));
      t = performance.now(); api.setSource(moved); times.push({ kind: 'position', ms: performance.now() - t });
    }
    return { times, error: api.error, warnings: api.warnings, nodes: document.querySelectorAll('#scene *').length };
  }, source);
  expect(measures.error).toBeNull(); expect(measures.warnings).toEqual([]);
  await info.attach('editor-timings', { body: JSON.stringify(measures, null, 2), contentType: 'application/json' });
  console.log('48-element editor timings', JSON.stringify(measures));
  await page.evaluate(() => (window as any).__scada.fit());
  await page.screenshot({ path: info.outputPath('48-elements.png') });
});
