// Exact before/after editor probe. Run npm run build first; use QA_CAPTURE_DIR for outputs.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
await build({ entryPoints: ["challenges/fixtures.ts"], outfile: ".test/runtime-qa-fixtures.mjs", bundle: true, platform: "node", format: "esm", packages: "external", target: "es2022" });
const { crowdedCircuit } = await import(new URL("../.test/runtime-qa-fixtures.mjs", import.meta.url).href);
const dir = resolve(process.env.QA_CAPTURE_DIR || ".runtime-evidence/after");
await mkdir(dir, { recursive: true });
const root = resolve("dist");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".map": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname).replace(/^\/scada(?=\/)/, "");
    const path = resolve(root, "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname));
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }).end(await readFile(path));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/scada/`);
  await page.waitForFunction(() => !!window.__scada);
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(dir, "editor.png") });
  const initial = await page.evaluate(() => window.__scada.source);
  const frames = async () => await page.evaluate(() => new Promise((resolve2) => {
    const values = [];
    let last = 0;
    const loop = (now) => {
      if (last) values.push(now - last);
      last = now;
      if (values.length < 180) {
        requestAnimationFrame(loop);
        return;
      }
      values.sort((a, b) => a - b);
      resolve2({ count: values.length, medianMs: values[Math.floor(values.length * 0.5)], p95Ms: values[Math.floor(values.length * 0.95)], maxMs: values.at(-1), meanMs: values.reduce((a, b) => a + b, 0) / values.length });
    };
    requestAnimationFrame(loop);
  }));
  const baselineFrames = await frames();
  const rows = [];
  for (const count of [8, 16, 32, 48]) {
    const source = crowdedCircuit(count);
    const measurement = await page.evaluate(({ source: source2, count: count2 }) => {
      const api = window.__scada;
      const times = [];
      let t = performance.now();
      api.setSource(source2);
      times.push({ kind: "initial", ms: performance.now() - t });
      const rotor = document.querySelector('[data-part="rotor"]');
      for (let i = 0; i < 6; i++) {
        const p = source2.replace('pump("N1", {', `pump("N1", {rpm:${1e3 + i * 100},`);
        t = performance.now();
        api.setSource(p);
        if (i) times.push({ kind: "parameter", ms: performance.now() - t });
      }
      const sameRotor = rotor === document.querySelector('[data-part="rotor"]');
      const m = source2.match(/const n1 = pump\("N1", \{"x":(\d+)/);
      for (let i = 1; i <= 4; i++) {
        const moved = source2.replace(m[0], m[0].replace(/\d+$/, String(Number(m[1]) + i)));
        t = performance.now();
        api.setSource(moved);
        if (i > 1) times.push({ kind: "position", ms: performance.now() - t });
      }
      return { count: count2, links: count2 - 1, times, sameRotor, error: api.error, warnings: api.warnings, svgNodes: document.querySelectorAll("#scene *").length };
    }, { source, count });
    rows.push(measurement);
  }
  const crowdedFrames = await frames();
  await page.evaluate(() => window.__scada.fit());
  await page.screenshot({ path: resolve(dir, "editor-48.png") });
  await page.evaluate((s) => window.__scada.setSource(s), initial);
  const sourceEdit = await page.evaluate(() => {
    const api = window.__scada;
    const source = api.source;
    api.setSource(source + "\n// QA edit preservation");
    api.undo();
    const undo = api.source === source;
    api.redo();
    return { undo, redo: api.source === source + "\n// QA edit preservation" };
  });
  const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((x) => ({ name: new URL(x.name).pathname, transferSize: x.transferSize, decodedBodySize: x.decodedBodySize })));
  const report = { measuredAt: (/* @__PURE__ */ new Date()).toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTreeDirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), node: process.version, browser: browser.version(), platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpus: os.availableParallelism(), viewport: { width: 1440, height: 900 }, methodology: "Native Chromium RAF: 180 samples default 8 nodes and idle adversarial 48-node circuit. Synchronous source edits: warm-up excluded, 5 parameter samples and 3 geometry samples per circuit, seed 42. Shared software-rendering runtime; not device FPS. Identical probe and fixture for before/after.", rows, baselineFrames, crowdedFrames, sourceEdit, resources, errors };
  await writeFile(resolve(dir, "measurements.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: resolve(dir, "measurements.json"), baselineFrames, crowdedFrames, rows: rows.map((row) => ({ count: row.count, times: row.times, sameRotor: row.sameRotor, error: row.error })), errors }));
} finally {
  await browser.close();
  await new Promise((r) => server.close(() => r()));
}
