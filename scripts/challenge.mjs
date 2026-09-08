import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const selected = process.argv[2] ?? 'all';
if (!['all', 'core', 'browser', 'bench'].includes(selected)) throw new Error('Use all, core, browser or bench');
await mkdir('challenge-results', { recursive: true });
let status = 0;
function run(args, timeout = 180_000) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout });
  if (result.error) console.error(result.error.message);
  status = Math.max(status, result.status ?? 1);
}
if (selected === 'all' || selected === 'core') {
  await build({ entryPoints: ['challenges/core.test.ts'], outfile: '.test/challenge/core.test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'es2022' });
  run(['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', '--test-reporter-destination=challenge-results/core.tap', '.test/challenge/core.test.mjs']);
}
if (selected === 'all' || selected === 'browser') {
  run(['scripts/build.mjs']);
  // Resolve through Node so an externally provisioned node_modules also works.
  run(['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.challenge.config.ts']);
}
if (selected === 'all' || selected === 'bench') {
  await build({ entryPoints: ['challenges/benchmark.ts'], outfile: '.test/challenge/benchmark.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'es2022' });
  run(['.test/challenge/benchmark.mjs']);
}
process.exitCode = status;
