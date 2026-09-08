import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { compile } from '../src/source';
import { layout } from '../src/geometry';
import { crowdedCircuit } from './fixtures';

const milliseconds = (value: number) => Math.round(value * 100) / 100;
const rows = [];
for (const count of [8, 16, 32, 48]) {
  const source = crowdedCircuit(count);
  await mkdir('challenge-results/fixtures', { recursive: true });
  await writeFile(`challenge-results/fixtures/circuit-${count}.ts`, source);
  const samples = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    let started = performance.now();
    const scene = compile(source).scene;
    const compileMs = performance.now() - started;
    started = performance.now();
    const geometry = layout(scene);
    const layoutMs = performance.now() - started;
    assert.deepEqual(geometry.warnings, [], `Benchmark fixture ${count} must be warning-free`);
    if (iteration > 0) samples.push({ compileMs, layoutMs });
  }
  const median = (key: 'compileMs' | 'layoutMs') => milliseconds(samples.map(s => s[key]).sort((a, b) => a - b)[1]);
  const row = { elements: count, links: count - 1, compileMedianMs: median('compileMs'), layoutMedianMs: median('layoutMs'), samples };
  rows.push(row); console.log(JSON.stringify(row));
}
let revision = 'unknown';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Archives have no git metadata. */ }
const report = { measuredAt: new Date().toISOString(), revision, node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.availableParallelism(), methodology: 'Seed 42; complete series circuit; separated equipment; shuffled connections; 1 warm-up + 3 measured samples; synchronous compile and layout only, no DOM/paint. Shared runtime, not a device FPS claim.', rows };
await writeFile('challenge-results/benchmark.json', JSON.stringify(report, null, 2) + '\n');
