import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/review.test.ts'], outfile: '.test/review.test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24' });
const result = spawnSync(process.execPath, ['--test', '.test/review.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
