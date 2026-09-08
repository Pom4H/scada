import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serveLab } from './lab-server.mjs';

export async function buildLab() {
  await mkdir('.lab-dist', { recursive: true });
  await build({ entryPoints: ['lab3d/main.ts'], outfile: '.lab-dist/lab.js', bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'inline' });
  await copyFile('lab3d/index.html', '.lab-dist/index.html');
  const [html, js, css] = await Promise.all(['index.html', 'lab.js', 'lab.css'].map(file => readFile(`.lab-dist/${file}`, 'utf8')));
  await writeFile('.lab-dist/standalone.html', html.replace('<link rel="stylesheet" href="./lab.css">', () => `<style>${css}</style>`).replace('<script type="module" src="./lab.js"></script>', () => `<script>${js.replaceAll('</script', '<\\/script')}</script>`));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildLab();
  console.log('Built equipment lab → .lab-dist/ (including standalone.html)');
  if (process.argv.includes('--serve')) {
    const { url } = await serveLab(4174); console.log(`Equipment lab: ${url}`);
  }
}
