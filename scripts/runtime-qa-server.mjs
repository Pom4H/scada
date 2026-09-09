import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';

await build({entryPoints:['server/index.ts'],outfile:'.test/runtime-qa-server.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'es2022'});
const {startServer}=await import(pathToFileURL(resolve('.test/runtime-qa-server.mjs')).href);
const temporary=await mkdtemp(join(tmpdir(),'scada-browser-qa-'));
const port=Number(process.env.SCADA_QA_PORT||4188);
const application=await startServer({
  port,host:'127.0.0.1',dataPath:join(temporary,'runs.sqlite'),staticDir:resolve('dist'),autoTick:true,
  tokens:{view:'qa-view-only-137246-stage',operator:'qa-operator-482615-stage',research:'qa-research-573826-stage'},
  allowedOrigins:[`http://127.0.0.1:${port}`],
});
console.log(`SCADA QA server: ${application.url}`);
// A test-owned proxy physically closes established SSE streams. Chromium's
// network emulation alone can leave an already-open local stream delivering data.
const proxyPort=port+1,active=new Set();let disconnected=false;
const proxy=createServer((req,res)=>{
  if(req.url==='/__qa__/cut'||req.url==='/__qa__/restore'){
    if(req.method!=='POST'||req.headers['x-scada-qa']!=='network-fixture'){res.writeHead(403).end();return;}
    disconnected=req.url.endsWith('/cut');
    if(disconnected)for(const pair of active){pair.upstream.destroy();pair.downstream.destroy();}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({disconnected}));return;
  }
  if(disconnected){res.writeHead(503).end('QA simulated connection loss');return;}
  const upstream=httpRequest({hostname:'127.0.0.1',port,method:req.method,path:req.url,headers:req.headers},incoming=>{
    res.writeHead(incoming.statusCode??502,incoming.headers);incoming.pipe(res);
  });
  const pair={upstream,downstream:res};active.add(pair);
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502).end('QA upstream connection closed');else res.destroy();});
  res.on('close',()=>{active.delete(pair);upstream.destroy();});req.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(proxyPort,'127.0.0.1',resolve));
console.log(`SCADA QA disconnect proxy: http://127.0.0.1:${proxyPort}`);
let closing=false;
const close=async()=>{if(closing)return;closing=true;for(const pair of active){pair.upstream.destroy();pair.downstream.destroy();}await new Promise(resolve=>proxy.close(resolve));await application.close();await rm(temporary,{recursive:true,force:true});process.exit(0);};
process.on('SIGINT',close);process.on('SIGTERM',close);
