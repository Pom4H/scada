import { mkdir, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const modules = resolve('examples/consumer/node_modules');
await mkdir(`${modules}/@pom4h`, {recursive:true});
try {
  await symlink(resolve('.'), `${modules}/@pom4h/scada`, 'junction');
  const compiler = resolve('node_modules/typescript/bin/tsc');
  let result = spawnSync(process.execPath, [compiler, '-p', 'examples/consumer/tsconfig.json'], {stdio:'inherit'});
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    await build({entryPoints:['examples/consumer/index.ts'],outfile:'.test/consumer.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
    result = spawnSync(process.execPath, ['.test/consumer.mjs'], {stdio:'inherit'}); process.exitCode = result.status ?? 1;
  }
} finally { await rm(modules,{recursive:true,force:true}); }
