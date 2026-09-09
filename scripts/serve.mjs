import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('dist'), port = Number(process.env.PORT || 4173);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.map':'application/json' };
createServer(async (req, res) => {
  try {
    if (process.env.SCADA_DEV === '1' && new URL(req.url, 'http://local').pathname.endsWith('/__dev/revision')) { res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(await readFile(resolve(root, 'revision.json'))); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/^\/scada(?=\/)/, '');
    const path = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(path); res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control':'no-store' }); res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`SCADA: http://localhost:${port}/scada/`));
