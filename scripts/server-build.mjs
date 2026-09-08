import { build } from 'esbuild';
await build({ entryPoints: ['server/cli.ts'], outfile: '.server/cli.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', sourcemap: true });
