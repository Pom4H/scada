import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { RunEngine, RuntimeError, STEP_MS, validateCreate, validateEquipmentCommand } from './engine';
import type { RuntimeFrame } from '../src/runtime/protocol';

export interface Tokens { view: string; operator: string; research: string }
export interface ServerOptions {
  host?: string;
  port?: number;
  dataPath?: string;
  staticDir?: string;
  tokens?: Tokens;
  allowedOrigins?: string[];
  autoTick?: boolean;
  onError?: (error: unknown) => void;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const integer = (value: string | null, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (value === null) return fallback;
  if (!/^-?\d+$/.test(value)) throw new RuntimeError('Invalid integer query parameter');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new RuntimeError('Query parameter is outside the allowed range');
  return parsed;
};
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RuntimeError('Use Content-Type: application/json', 415);
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new RuntimeError('Compressed request bodies are not supported', 415);
  if (Number(req.headers['content-length'] ?? 0) > 512000) throw new RuntimeError('Request body is too large', 413);
  return new Promise((accept, reject) => {
    let length = 0, failed = false; const chunks: Buffer[] = [];
    const fail = (error: unknown) => { if (!failed) { failed = true; chunks.length = 0; reject(error); } };
    req.on('data', (chunk: Buffer) => { if (failed) return; length += chunk.length; if (length > 512000) fail(new RuntimeError('Request body is too large', 413)); else chunks.push(chunk); });
    req.once('aborted', () => fail(new RuntimeError('Incomplete request body')));
    req.once('error', fail);
    req.once('end', () => {
      if (failed) return;
      try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new RuntimeError('Malformed JSON')); }
    });
  });
}
/** Importing this module never starts I/O. CLI startup lives in server/cli.ts. */
export async function startServer(options: ServerOptions = {}) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 4175;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port');
  const tokens: Tokens = options.tokens ?? { view: randomBytes(24).toString('base64url'), operator: randomBytes(24).toString('base64url'), research: randomBytes(24).toString('base64url') };
  if (Object.values(tokens).some(token => typeof token !== 'string' || !token.trim()) || new Set(Object.values(tokens)).size !== 3) throw new Error('Provide three distinct non-empty access tokens');
  const credentials = Object.entries(tokens).map(([role, token]) => ({ role, hash: digest(token) }));
  const origins = new Set(options.allowedOrigins ?? []);
  for (const origin of origins) { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('allowedOrigins must contain exact HTTP(S) origins'); }
  const engine = new RunEngine(options.dataPath ?? resolve('data/runs.sqlite'));
  const root = resolve(options.staticDir ?? 'dist');
  const streams = new Set<ServerResponse>(); let closed = false;
  const onError = options.onError ?? (error => console.error('SCADA runtime error:', error instanceof Error ? error.message : error));
  let serverOrigin = '';
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webm': 'video/webm', '.wasm': 'application/wasm' };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const origin = req.headers.origin;
      const sameOrigin = origin === serverOrigin || origin === `http://localhost:${(server.address() as { port: number })?.port}` || origin === `http://127.0.0.1:${(server.address() as { port: number })?.port}`;
      if (origin && !sameOrigin && !origins.has(origin)) throw new RuntimeError('Origin is not allowed', 403);
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' }).end(); return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { status: 'ok', synthetic: true, stepMs: STEP_MS }); return; }
      if (url.pathname.startsWith('/api/')) {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ') || header.length > 4096) throw new RuntimeError('Access token required', 401);
        const supplied = digest(header.slice(7));
        let role = '';
        for (const credential of credentials) if (timingSafeEqual(supplied, credential.hash)) role = credential.role;
        if (!role) throw new RuntimeError('Invalid access token', 401);
        const operator = () => { if (role === 'view') throw new RuntimeError('Operator access required', 403); };
        if (url.pathname === '/api/runs' && req.method === 'GET') { json(res, 200, { runs: engine.list(url.searchParams.get('projectId') ?? undefined) }); return; }
        if (url.pathname === '/api/runs' && req.method === 'POST') { operator(); json(res, 201, engine.create(validateCreate(await body(req)))); return; }
        const match = /^\/api\/runs\/([a-zA-Z0-9_-]{1,80})(?:\/(events|commands|history|replay|research|complete))?$/.exec(url.pathname);
        if (!match) throw new RuntimeError('Endpoint not found', 404);
        const [, id, action] = match;
        if (!action && req.method === 'GET') { json(res, 200, engine.get(id)); return; }
        if (action === 'complete' && req.method === 'POST') { operator(); json(res, 200, engine.complete(id)); return; }
        if (action === 'commands' && req.method === 'POST') { operator(); json(res, 200, engine.command(id, validateEquipmentCommand(await body(req)))); return; }
        if (action === 'history' && req.method === 'GET') { json(res, 200, engine.history(id, integer(url.searchParams.get('after'), 0, -1), integer(url.searchParams.get('limit'), 500, 1, 1000))); return; }
        if (action === 'replay' && req.method === 'GET') {
          if (!url.searchParams.has('seq')) throw new RuntimeError('Replay requires seq');
          json(res, 200, engine.replay(id, integer(url.searchParams.get('seq'), 0, 0))); return;
        }
        if (action === 'research' && req.method === 'GET') {
          if (role !== 'research') throw new RuntimeError('Research access required', 403);
          json(res, 200, engine.research(id, integer(url.searchParams.get('after'), -1, -1), integer(url.searchParams.get('limit'), 500, 1, 1000))); return;
        }
        if (action === 'events' && req.method === 'GET') {
          integer(url.searchParams.get('after'), 0, -1);
          const snapshot = engine.get(id).snapshot;
          if (streams.size >= 64) throw new RuntimeError('Too many active streams', 429);
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders(); streams.add(res);
          const write = (frame: RuntimeFrame) => { if (res.destroyed || res.writableLength > 1024 * 1024) { res.destroy(); return; } res.write(`event: frame\nid: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`); };
          // A full latest snapshot is an intentional recovery baseline. History fills the gap separately.
          write(snapshot);
          const unsubscribe = engine.subscribe(id, write);
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 5000); heartbeat.unref();
          res.on('close', () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
          return;
        }
        throw new RuntimeError('Method not allowed', 405);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new RuntimeError('Method not allowed', 405);
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname).replace(/^\/scada(?=\/|$)/, '') || '/'; } catch { throw new RuntimeError('Malformed path'); }
      const path = resolve(root, '.' + (pathname.endsWith('/') ? `${pathname}index.html` : pathname));
      if (!path.startsWith(root + sep)) throw new RuntimeError('Path not allowed', 403);
      let data: Buffer;
      try { const resolved = await realpath(path); if (!resolved.startsWith(await realpath(root) + sep)) throw new RuntimeError('Path not allowed', 403); data = await readFile(resolved); } catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('File not found. Run npm run build first.', 404); }
      res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof RuntimeError) json(res, error.status, { error: error.message });
      else { onError(error); json(res, 500, { error: 'Internal runtime error' }); }
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  try { await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); accept(); }); }); }
  catch (error) { engine.close(); throw error; }
  const address = server.address() as { address: string; port: number };
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  serverOrigin = `http://${urlHost}:${address.port}`;
  const timer = options.autoTick === false ? undefined : setInterval(() => { try { engine.stepAll(); } catch (error) { onError(error); } }, STEP_MS);
  timer?.unref();
  return {
    server, engine, tokens, url: serverOrigin,
    async close() { if (closed) return; closed = true; if (timer) clearInterval(timer); for (const stream of streams) stream.destroy(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); engine.close(); },
  };
}
