import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
export async function serveLab(port = 0) {
  const files = new Map([['/', ['index.html', 'text/html']], ['/lab.js', ['lab.js', 'text/javascript']], ['/lab.css', ['lab.css', 'text/css']], ['/standalone.html', ['standalone.html', 'text/html']]]);
  const server = createServer(async (req, res) => {
    const file = files.get(new URL(req.url, 'http://localhost').pathname);
    if (!file) { res.writeHead(404); res.end(); return; }
    try { const data = await readFile(`.lab-dist/${file[0]}`); res.writeHead(200, { 'Content-Type': file[1] }); res.end(data); }
    catch { res.writeHead(500); res.end('Build the lab first'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
