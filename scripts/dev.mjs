import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

process.env.SCADA_DEV = '1';
async function signature() {
  const hash = createHash('sha256');
  async function scan(path) {
    const info = await stat(path);
    if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await scan(`${path}/${entry}`);
    else { hash.update(path); hash.update(await readFile(path)); }
  }
  for (const path of ['src', 'public', 'index.html', 'scripts/build.mjs']) await scan(path);
  return hash.digest('hex');
}
function build() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/build.mjs'], {stdio:'inherit',env:process.env});
    child.on('error', error => { console.error(error); resolve(false); });
    child.on('exit', code => resolve(code === 0));
  });
}
let last = await signature();
if (!await build()) process.exit(1);
const server = spawn(process.execPath, ['scripts/serve.mjs'], {stdio:'inherit',env:process.env});
let checking = false;
const timer = setInterval(async () => {
  if (checking) return; checking = true;
  try {
    const next = await signature();
    if (next !== last) { last = next; await build(); }
  } catch (error) { console.error('Development rebuild:', error); }
  finally { checking = false; }
}, 500);
function stop() { clearInterval(timer); server.kill('SIGTERM'); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
server.once('exit', code => { clearInterval(timer); process.exitCode = code ?? 1; });
console.log(`Watching ${resolve('src')} — valid builds reload the browser; invalid builds preserve dist.`);
