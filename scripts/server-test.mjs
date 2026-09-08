import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/server-model.test.ts'], outfile: '.test/server-model.test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24' });
const result = spawnSync(process.execPath, ['--test', '.test/server-model.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
