import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({entryPoints:['tests/runtime-contract.test.ts'],outfile:'.test/runtime-contract.test.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'es2022'});
const result=spawnSync(process.execPath,['--test','.test/runtime-contract.test.mjs'],{stdio:'inherit'});
process.exitCode=result.status??1;
