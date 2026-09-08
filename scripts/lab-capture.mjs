import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildLab } from './lab-build.mjs';
import { serveLab } from './lab-server.mjs';

await buildLab();
const output = '.lab-evidence'; await mkdir(output, { recursive: true });
const { server, url } = await serveLab();
let browser;
const report = { browser: null, viewport: [1440, 960], cases: [], assertions: [], ocr: [], errors: [] };
try {
  browser = await chromium.launch({ executablePath: process.env.SCADA_CHROMIUM || undefined, args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => window.scadaLab?.ready);
  const cases = [
    ['overview', {}], ['front', { view: 'front' }], ['side', { view: 'side' }], ['top', { view: 'top' }],
    ['tank', { asset: 'TK-101' }], ['tank-empty', { asset: 'TK-101', scenario: 'empty' }], ['tank-full', { asset: 'TK-101', scenario: 'full' }],
    ['pump', { asset: 'P-101' }], ['pump-zero-flow', { asset: 'P-101', scenario: 'zero-flow' }], ['pump-reverse', { asset: 'P-101', scenario: 'reverse' }], ['pump-stopped', { asset: 'P-101', scenario: 'stopped' }],
    ['valve', { asset: 'V-101' }], ['valve-top', { asset: 'V-101', view: 'top' }], ['mismatch', { scenario: 'mismatch' }],
    ['stale', { scenario: 'stale' }], ['bad', { scenario: 'bad' }], ['offline', { scenario: 'offline' }], ['trip', { scenario: 'trip' }],
  ];
  for (const [name, options] of cases) {
    const metrics = await page.evaluate(o => window.scadaLab.setCase(o), options);
    await page.screenshot({ path: `${output}/${name}.png` });
    report.cases.push({ name, options, metrics });
    for (const asset of metrics.assets) for (const port of asset.ports) assert.ok(port.gap < 1e-8, `${name}: port gap`);
    assert.ok(metrics.triangles > 0 && metrics.triangles < 200000, `${name}: geometry budget`);
  }
  report.assertions.push('18 deterministic state/view captures; named port transforms within 1e-8 m; <200k rendered triangles in every case');
  const levels = [];
  for (const scenario of ['empty', 'normal', 'full', 'offline']) {
    await page.evaluate(scenario => window.scadaLab.setCase({ scenario }), scenario);
    levels.push(await page.locator('#tank-level-2d').getAttribute('d'));
  }
  assert.equal(new Set(levels).size, 4, '2D tank must distinguish empty/normal/full/unknown');
  assert.equal(levels[3], '');
  assert.ok((await page.locator('.asset-label.warning').count()) === 3, 'Unknown state visible on every 3D asset');
  report.assertions.push('Tank 2D level changes with the shared measurement; unknown has hatching and three explicit 3D quality labels');
  const metrics = name => report.cases.find(c => c.name === name).metrics;
  assert.equal(metrics('pump-zero-flow').assets[1].metrics.flow, 0);
  assert.ok(metrics('pump-zero-flow').assets[1].metrics.phase > 0);
  assert.equal(metrics('pump-reverse').assets[1].metrics.rpm, 1450);
  assert.ok(metrics('pump-reverse').flows[0].value < 0);
  for (const name of ['stale', 'bad', 'offline', 'pump-stopped', 'trip']) assert.ok(metrics(name).flows.every(f => !f.arrowsVisible));
  report.assertions.push('Zero/reverse flow independent of drive rotation; unavailable and zero flow suppress flow arrows');
  const motion = await page.evaluate(() => {
    const lab = window.scadaLab;
    const first = lab.setCase({ time: .9 });
    lab.setScenario('zero-flow'); const transition = lab.inspect(); lab.advance(.1); const next = lab.inspect();
    const replay = lab.setCase({ time: .9 });
    return { first, transition, next, replay };
  });
  assert.equal(motion.first.assets[1].metrics.phase, motion.transition.assets[1].metrics.phase);
  assert.notEqual(motion.next.assets[1].metrics.phase, motion.transition.assets[1].metrics.phase);
  assert.deepEqual(motion.first, motion.replay);
  report.assertions.push('Fixture transition preserves rotor phase; deterministic replay matches all metrics');
  for (const t of [0, .13, .31, .72]) {
    await page.evaluate(time => window.scadaLab.setCase({ asset: 'P-101', time }), t);
    await page.screenshot({ path: `${output}/motion-${t.toFixed(2)}.png` });
  }
  const recording = await page.evaluate(async () => {
    const lab = window.scadaLab; lab.setCase({ time: 0 });
    const stream = document.querySelector('canvas').captureStream(20);
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('This browser cannot record WebM');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1400000 }), chunks = [], intervals = [];
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    let started, previous, lastScenario = 'normal';
    await new Promise(resolve => {
      function frame(now) {
        started ??= now; previous ??= now;
        const elapsed = (now - started) / 1000, dt = (now - previous) / 1000; previous = now;
        const scenario = elapsed < 1.5 ? 'normal' : elapsed < 3 ? 'zero-flow' : elapsed < 4.5 ? 'reverse' : 'offline';
        if (scenario !== lastScenario) { lab.setScenario(scenario); lastScenario = scenario; }
        lab.advance(dt); if (dt > 0) intervals.push(dt * 1000);
        if (elapsed < 6) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    return { bytes: Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer())), mimeType, frames: intervals.length, worstFrameMs: Math.max(...intervals), meanFrameMs: intervals.reduce((a, b) => a + b, 0) / intervals.length };
  });
  await writeFile(`${output}/motion.webm`, Buffer.from(recording.bytes));
  const { bytes, ...recordingMetrics } = recording; report.recording = { ...recordingMetrics, scope: 'Six-second 3D canvas capture under software rendering; excludes DOM overlays; not a production performance benchmark' };
  await page.evaluate(() => window.scadaLab.setCase({}));
  for (const tag of ['TK-101', 'P-101', 'V-101']) assert.ok(await page.locator(`#svg-${tag}`).textContent());
  await page.locator('#search').fill('centrifugal');
  assert.ok((await page.locator('.catalog-grid a').count()) > 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scadaLab.setCase({ asset: 'V-101', scenario: 'trip' }));
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile horizontal overflow');
  assert.ok(await page.locator('#viewport-alert').evaluate(e => e.getBoundingClientRect().bottom < innerHeight && e.textContent.includes('P-101')), 'Trip must be visible above the mobile fold');
  assert.ok(await page.locator('.schematic svg').evaluate(e => {
    const text = e.querySelector('text');
    return parseFloat(getComputedStyle(text).fontSize) * e.getBoundingClientRect().width / e.viewBox.baseVal.width >= 12;
  }), 'Mobile schematic text should remain at least 12 CSS px');
  const controls = await page.locator('button, select, input').evaluateAll(items => items.filter(e => e.getBoundingClientRect().width > 0).map(e => ({ name: e.id || e.textContent.trim(), width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })));
  assert.ok(controls.every(c => c.width >= 44 && c.height >= 44), 'Minimum control target size');
  report.assertions.push('390px layout has no horizontal overflow; visible controls at least 44×44 CSS px; catalog search returns results');
  for (const [name, words] of [['overview', ['TK-101', 'P-101', 'V-101']], ['trip', ['TRIP']], ['offline', ['OFFLINE', 'UNKNOWN']]]) {
    const result = spawnSync('tesseract', [`${output}/${name}.png`, 'stdout', '-l', 'eng', '--psm', '11'], { encoding: 'utf8' });
    if (result.error) throw new Error('OCR requires tesseract with English language data');
    assert.equal(result.status, 0, result.stderr);
    const text = result.stdout;
    await writeFile(`${output}/${name}.ocr.txt`, text);
    const missing = words.filter(w => !text.toUpperCase().includes(w));
    report.ocr.push({ name, expected: words, missing });
    assert.deepEqual(missing, [], `OCR missing text in ${name}`);
  }
  await page.goto(`${url}standalone.html`); await page.waitForFunction(() => window.scadaLab?.ready);
  assert.ok((await page.evaluate(() => window.scadaLab.inspect())).triangles > 0);
  report.assertions.push('Self-contained HTML starts and renders geometry');
  assert.deepEqual(report.errors, [], 'Browser errors');
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, assertions: report.assertions, ocr: report.ocr, browser: report.browser }, null, 2));
} catch (error) { report.status = 'failed'; report.failure = String(error); throw error; }
finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
