import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/lab.test.ts'], outfile: '.test/lab.test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'es2022' });
const result = spawnSync(process.execPath, ['--test', '.test/lab.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
