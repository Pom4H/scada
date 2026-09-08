import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile, patchFields, applyChanges, appendEquipment, SourceError } from '../src/source';
import { registerComponent, catalog } from '../src/core';
import { booster } from '../src/examples';
import { numeric, type RuntimeFrame, type EquipmentCommand, type HistoryPage } from '../src/runtime/protocol';
import { RuntimeClient, isFrame, offlineFrame } from '../src/runtime/client';
import { startServer } from '../server/index';

const credentials = { view: 'qa-view-only-137246-stage', operator: 'qa-operator-482615-stage', research: 'qa-research-573826-stage' };
const runtimeSource = (server = 'http://127.0.0.1:4175') =>
  `import { runtime } from '@scada/core';\nruntime({server:${JSON.stringify(server)},project:'qa-water'});\n` +
  booster.replace('rpm: 1500', 'rpm: 1500, degradationRate: 0.1, maintenanceSeconds: 0.2');

test('runtime metadata parses as data without network, commands or source changes', () => {
  const source = runtimeSource();
  const before = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => { requests++; throw new Error('compile attempted I/O'); }) as typeof fetch;
  try {
    const c = compile(source);
    assert.deepEqual(c.runtime, { server: 'http://127.0.0.1:4175', project: 'qa-water' });
    assert.equal(c.file.text, source);
    assert.equal(requests, 0);
    assert.equal(c.scene.nodes.length, compile(booster).scene.nodes.length);
    assert.throws(() => compile(source + '\nfetch("http://127.0.0.1:4175/api/runs");'), SourceError);
    assert.throws(() => compile(source + '\nmotor.start();'), SourceError);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = before; }
});

test('runtime credentials, ambiguous endpoints, unknown fields and duplicate declarations are rejected', () => {
  for (const server of ['javascript:alert(1)', 'file:///tmp/run', 'http://remote.example', 'https://u:secret@example.com', 'https://example.com?token=secret', 'https://example.com#token']) {
    assert.throws(() => compile(runtimeSource(server)), SourceError, server);
  }
  assert.equal(compile(runtimeSource('https://demo.example/scada')).runtime?.server, 'https://demo.example/scada');
  assert.throws(() => compile(runtimeSource().replace("project:'qa-water'", "project:'qa-water',token:'secret'")), SourceError);
  assert.throws(() => compile(runtimeSource() + '\nruntime({server:"http://localhost:4175",project:"other"});'), SourceError);
});

test('legacy documents and visual edits preserve authored metadata and unrelated bytes', () => {
  assert.equal(compile(booster).runtime, undefined);
  const source = '// Preserve this exact Unicode comment: насос → вода\n' + runtimeSource();
  const changed = applyChanges(source, patchFields(source, 'P-101', { rpm: 900 }));
  assert.equal(changed, source.replace('rpm: 1500', 'rpm: 900'));
  assert.deepEqual(compile(changed).runtime, compile(source).runtime);
  assert.equal(compile(booster).scene.nodes.length, 8);
});

test('a separately registered type has custom parameters and named ports in the existing compiler', () => {
  registerComponent('qaBeacon', {
    version: '1.0.0', label: 'QA beacon', prefix: 'QA', width: 90, height: 50,
    fields: {
      x: {label:'X',default:0,min:-100,max:100}, y: {label:'Y',default:0,min:-100,max:100},
      enabled: {label:'Enabled',default:true}, gain: {label:'Gain',default:1,min:0,max:10},
    },
    ports: { supply: {x:0,y:25,direction:'left',role:'in'}, drain: {x:90,y:25,direction:'right',role:'out'}, auxiliary: {x:45,y:50,direction:'down',role:'out'} },
    signals: { active: {label:'Active',type:'boolean',unit:'bool'} },
    commands: { reset: {label:'Reset'} },
  });
  const c = compile('import {component} from "@scada/core"; const q=component("qaBeacon","Q-1",{x:10,y:20,gain:4,enabled:false});');
  assert.equal(c.scene.nodes[0].kind, 'qaBeacon');
  assert.equal(c.scene.nodes[0].props.enabled, false);
  assert.equal(c.scene.nodes[0].props.gain, 4);
  assert.equal(Object.keys(catalog.qaBeacon.ports).length, 3);
  assert.throws(() => compile('import {component} from "@scada/core"; const q=component("qaBeacon","Q",{gain:99});'), SourceError);
  const installed = compile('import {component} from "@scada/core"; const f=component("filter","FLT-1",{x:1,y:2,resistance:0.25});');
  assert.equal(installed.scene.nodes[0].kind, 'filter');
  const appended = appendEquipment(booster, 'filter', 500, 550);
  assert.equal(compile(appended).scene.nodes.at(-1)?.kind, 'filter');
});

test('typed unknown sensor values remain distinct from a confirmed numeric zero', () => {
  const sample = {type:'number' as const, value:0, unit:'m3/h',timestamp:100,quality:'good' as const};
  assert.equal(numeric(sample), 0);
  assert.equal(numeric({...sample,value:null}), null);
  assert.equal(numeric({...sample,value:Number.NaN}), null);
  for (const quality of ['stale','bad','offline'] as const) assert.equal(numeric({...sample,quality}), null);
  assert.equal(numeric({type:'boolean',value:false,unit:'bool',timestamp:100,quality:'good'}), null);
  assert.equal(numeric({type:'string',value:'0',unit:'',timestamp:100,quality:'good'}), null);
});

async function fixture(t: any, autoTick = false) {
  const dir = await mkdtemp(join(tmpdir(), 'scada-runtime-qa-'));
  const options = {port:0,host:'127.0.0.1',dataPath:join(dir,'runs.sqlite'),staticDir:join(process.cwd(),'dist'),tokens:credentials,allowedOrigins:['http://127.0.0.1:4178'],autoTick};
  let server = await startServer(options);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); } };
  t.after(async () => { await close(); await rm(dir,{recursive:true,force:true}); });
  return {
    get server() { return server; },
    async restart() { await close(); server=await startServer(options);closed=false;return server; },
    async request(path:string, init:RequestInit = {}, role:keyof typeof credentials|null='operator') {
      const headers = new Headers(init.headers);
      if(role) headers.set('Authorization',`Bearer ${credentials[role]}`);
      if(init.body) headers.set('Content-Type','application/json');
      return fetch(server.url + path,{...init,headers});
    },
    async create(scenario:'normal'|'degradation'='degradation',source=runtimeSource()) {
      const response=await this.request('/api/runs',{method:'POST',body:JSON.stringify({projectId:'qa-water',label:'QA run',source,scenario,seed:42})});
      assert.equal(response.status,201,await response.clone().text());
      const body=await response.json() as {run:{id:string;[key:string]:unknown};snapshot:RuntimeFrame};
      return body;
    },
  };
}

function assertFrame(frame: RuntimeFrame) {
  assert.ok(['snapshot','update'].includes(frame.type));
  assert.equal(typeof frame.runId,'string');
  assert.ok(Number.isSafeInteger(frame.seq) && frame.seq >= 0);
  assert.ok(Number.isFinite(frame.timestamp));
  assert.ok(Number.isFinite(frame.simTimeMs) && frame.simTimeMs >= 0);
  for (const [id,equipment] of Object.entries(frame.equipment)) {
    assert.equal(equipment.positionId,id);
    assert.equal(typeof equipment.instanceId,'string');
    assert.equal(typeof equipment.facts.mode,'string');
    assert.ok(['none','warning','trip'].includes(equipment.facts.alarm));
    for(const signal of Object.values(equipment.signals)) {
      assert.ok(['number','boolean','string'].includes(signal.type));
      assert.ok(['good','stale','bad','offline'].includes(signal.quality));
      assert.equal(typeof signal.unit,'string');
      assert.ok(Number.isFinite(signal.timestamp));
      if(signal.value!==null) assert.equal(typeof signal.value,signal.type);
    }
  }
  for(const signal of Object.values(frame.flows)) assert.equal(signal.type,'number');
}

test('API enforces authentication and roles without exposing credentials or research truth', async t => {
  const f=await fixture(t);
  const health=await f.request('/api/health',{},null);
  assert.equal(health.status,200);
  const healthText=await health.text();
  for(const secret of Object.values(credentials)) assert.equal(healthText.includes(secret),false);
  assert.equal((await f.request('/api/runs',{},null)).status,401);
  assert.equal((await f.request('/api/runs',{headers:{Authorization:'Bearer wrong-token'}},null)).status,401);
  assert.equal((await f.request('/api/runs',{method:'POST',body:JSON.stringify({projectId:'qa-water',source:booster,scenario:'normal'})},'view')).status,403);
  const {run,snapshot}=await f.create();assertFrame(snapshot);
  for(const path of [`/api/runs/${run.id}`,`/api/runs/${run.id}/history`,`/api/runs/${run.id}/replay?seq=${snapshot.seq}`,`/api/runs/${run.id}/events`]) {
    assert.equal((await f.request(path,{},null)).status,401,path);
  }
  assert.equal((await f.request(`/api/runs/${run.id}/research`,{},'view')).status,403);
  assert.equal((await f.request(`/api/runs/${run.id}/research`,{},'operator')).status,403);
  assert.equal((await f.request(`/api/runs/${run.id}/research`,{},'research')).status,200);
  const publicPayload=await (await f.request(`/api/runs/${run.id}`,{},'view')).json();
  function check(value:unknown) {
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)) {
      assert.ok(!['hidden','cause','impellerDamage','wear','initialConditions','scenario','seed'].includes(key),`public field ${key}`);
      check(child);
    }
  }
  check(publicPayload);
  const denied=await f.request(`/api/runs/${run.id}/commands`,{method:'POST',body:JSON.stringify({commandId:'denied',equipmentId:'P-101',command:'stop'})},'view');
  assert.equal(denied.status,403);
});

test('malformed source, commands and request shapes are rejected without mutation', async t => {
  const f=await fixture(t);
  const {run}=await f.create('normal');
  for(const source of ['while(true){}','import {component} from "@scada/core";component("uninstalled","X",{});','import {component} from "@scada/core";component("qaBeacon","Q",{});',' '.repeat(120001)]) {
    const r=await f.request('/api/runs',{method:'POST',body:JSON.stringify({projectId:'qa-water',source,scenario:'normal'})});
    assert.ok([400,413,422].includes(r.status),`${r.status}: ${await r.text()}`);
  }
  const invalid=[
    {commandId:'unknown',equipmentId:'P-101',command:'execute'},
    {commandId:'out-of-range',equipmentId:'P-101',command:'setSpeed',value:999999},
    {commandId:'bad-type',equipmentId:'P-101',command:'setSpeed',value:true},
    {commandId:'object',equipmentId:'P-101',command:'setSpeed',value:{rpm:500}},
    {commandId:'missing',equipmentId:'MISSING',command:'stop'},
    {commandId:'prototype',equipmentId:'P-101',command:'__proto__'},
  ];
  const before=await (await f.request(`/api/runs/${run.id}`)).json();
  for(const command of invalid) {
    const r=await f.request(`/api/runs/${run.id}/commands`,{method:'POST',body:JSON.stringify(command)});
    assert.ok([400,404,422].includes(r.status),`${r.status}: ${await r.text()}`);
  }
  const after=await (await f.request(`/api/runs/${run.id}`)).json();
  assert.deepEqual(after,before);
  assert.equal((await f.request('/api/runs?projectId=qa-water',{},'view')).status,200);
  assert.equal((await f.request('/api/runs',{headers:{Origin:'https://untrusted.example'}},'view')).status,403);
});

test('command retry is idempotent and payload reuse is rejected', async t => {
  const f=await fixture(t);const {run}=await f.create('normal');
  const command={commandId:'repeat-stop',equipmentId:'P-101',command:'stop'};
  const send=(value:unknown)=>f.request(`/api/runs/${run.id}/commands`,{method:'POST',body:JSON.stringify(value)});
  const first=await send(command);assert.equal(first.status,200);const receipt=await first.json();
  for(let i=0;i<3;i++){const again=await send(command);assert.equal(again.status,200);assert.deepEqual(await again.json(),receipt);}
  const conflict=await send({...command,command:'start'});assert.equal(conflict.status,409);
  const before=await (await f.request(`/api/runs/${run.id}`)).json();
  await f.restart();
  const retry=await send(command);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),receipt);
  assert.deepEqual(await (await f.request(`/api/runs/${run.id}`)).json(),before);
});

test('history pages, exact replay and SQLite restart retain run identity and source', async t => {
  const f=await fixture(t);const source=runtimeSource();const {run,snapshot}=await f.create('degradation',source);
  for(let i=0;i<15;i++)f.server.engine.stepAll();
  const current=await (await f.request(`/api/runs/${run.id}`)).json() as {snapshot:RuntimeFrame};
  assert.ok(current.snapshot.seq>snapshot.seq);assert.equal(current.snapshot.simTimeMs,1500);assertFrame(current.snapshot);
  let after=0;const frames:RuntimeFrame[]=[];
  for(let i=0;i<30;i++){
    const response=await f.request(`/api/runs/${run.id}/history?after=${after}&limit=3`,{},'view');assert.equal(response.status,200);
    const page=await response.json() as HistoryPage;
    assert.ok(page.frames.length<=3);
    for(const frame of page.frames){assertFrame(frame);assert.ok(frame.seq>after);assert.equal(frame.runId,run.id);frames.push(frame);after=frame.seq;}
    assert.equal(page.nextAfter,after);
    if(!page.hasMore)break;
    assert.ok(page.frames.length>0,'pagination must advance');
  }
  assert.equal(frames.at(-1)?.seq,current.snapshot.seq);
  assert.equal(new Set(frames.map(frame=>frame.seq)).size,frames.length);
  const middle=frames[Math.floor(frames.length/2)];
  const replay=await (await f.request(`/api/runs/${run.id}/replay?seq=${middle.seq}`,{},'view')).json();
  assert.deepEqual(replay,{...middle,type:'snapshot'});
  const research=await (await f.request(`/api/runs/${run.id}/research`,{},'research')).json();
  const containsSource=(value:unknown):boolean=>value===source || !!value && typeof value==='object' && Object.values(value).some(containsSource);
  assert.ok(containsSource(research),'research manifest preserves exact source');
  assert.ok(JSON.stringify(research).includes('behaviorVersions'));
  assert.ok(JSON.stringify(research).includes('initialConditions'));
  await f.restart();
  const resumed=await (await f.request(`/api/runs/${run.id}`)).json() as {snapshot:RuntimeFrame};
  assert.deepEqual(resumed,current);
  f.server.engine.stepAll();
  const next=await (await f.request(`/api/runs/${run.id}`)).json() as {snapshot:RuntimeFrame};
  assert.equal(next.snapshot.seq,current.snapshot.seq+1);
  assert.equal(next.snapshot.simTimeMs,current.snapshot.simTimeMs+100);
});

test('pump degradation, service and replacement preserve physical position and distinguish installed instances', async t => {
  const f=await fixture(t);const {run}=await f.create();
  const get=async()=>((await (await f.request(`/api/runs/${run.id}`)).json()) as {snapshot:RuntimeFrame}).snapshot;
  const send=async(command:string,id:string)=>{
    const r=await f.request(`/api/runs/${run.id}/commands`,{method:'POST',body:JSON.stringify({commandId:id,equipmentId:'P-101',command})});assert.equal(r.status,200,await r.clone().text());
  };
  for(let i=0;i<25;i++)f.server.engine.stepAll();
  const normal=(await get()).equipment['P-101'];
  for(let i=0;i<65;i++)f.server.engine.stepAll();
  const degraded=(await get()).equipment['P-101'];
  assert.equal(numeric(normal.signals.rpm),numeric(degraded.signals.rpm));
  assert.ok(numeric(degraded.signals.flow)!<numeric(normal.signals.flow)!);
  assert.ok(numeric(degraded.signals.vibration)!>numeric(normal.signals.vibration)!);
  await send('service','service-once');
  for(let i=0;i<5;i++)f.server.engine.stepAll();
  const serviced=(await get()).equipment['P-101'];
  assert.equal(serviced.instanceId,degraded.instanceId);
  assert.equal(serviced.positionId,degraded.positionId);
  for(let i=0;i<15;i++)f.server.engine.stepAll();
  assert.ok(numeric((await get()).equipment['P-101'].signals.flow)!>numeric(degraded.signals.flow)!);
  await send('replace','replace-once');
  for(let i=0;i<5;i++)f.server.engine.stepAll();
  const replaced=(await get()).equipment['P-101'];
  assert.equal(replaced.positionId,serviced.positionId);
  assert.notEqual(replaced.instanceId,serviced.instanceId);
});

test('identical epochs, inputs, seed and command schedule produce identical durable frames', async t => {
  const a=await fixture(t),b=await fixture(t);
  const input={projectId:'repeatable',source:runtimeSource(),scenario:'degradation' as const,seed:7264};
  const options={id:'deterministic-run',epoch:1788883200000};
  assert.deepEqual(a.server.engine.create(input,options),b.server.engine.create(input,options));
  for(let i=1;i<=160;i++) {
    if(i===120) {
      const command:EquipmentCommand={commandId:'same-service',equipmentId:'P-101',command:'service'};
      assert.deepEqual(a.server.engine.command(options.id,command),b.server.engine.command(options.id,command));
    }
    a.server.engine.stepAll();b.server.engine.stepAll();
    assert.deepEqual(a.server.engine.get(options.id),b.server.engine.get(options.id),`step ${i}`);
  }
  assert.deepEqual(a.server.engine.history(options.id,-1,1000),b.server.engine.history(options.id,-1,1000));
  assert.deepEqual(a.server.engine.research(options.id),b.server.engine.research(options.id));
});

test('the installed filter package contributes behavior, signals and commands through public registration', async t => {
  const f=await fixture(t);
  const source=`import {tank,pump,outlet,component,connect} from '@scada/core';
const t=tank('T',{x:0,y:0});
const p=pump('P',{x:300,y:0,rpm:1500});
const f=component('filter','FLT',{x:600,y:0,resistance:0.5});
const o=outlet('O',{x:900,y:0});
connect(t.outlet,p.inlet);connect(p.outlet,f.inlet);connect(f.outlet,o.inlet);`;
  const {run}=await f.create('normal',source);
  for(let i=0;i<30;i++)f.server.engine.stepAll();
  const before=f.server.engine.get(run.id).snapshot.equipment.FLT;
  assert.equal(numeric(before.signals.flow),6);
  assert.equal(numeric(before.signals.differentialPressure),.5);
  f.server.engine.command(run.id,{commandId:'clean-filter',equipmentId:'FLT',command:'clean'});
  const after=f.server.engine.get(run.id).snapshot.equipment.FLT;
  assert.equal(numeric(after.signals.flow),12);
  assert.equal(numeric(after.signals.differentialPressure),0);
  assert.equal(after.instanceId,before.instanceId);
});

test('history, replay and SSE reject invalid ranges and isolate run records', async t => {
  const f=await fixture(t);const a=await f.create('normal'),b=await f.create('degradation');
  for(let i=0;i<5;i++)f.server.engine.step(a.run.id);
  for(const suffix of ['history?after=-2','history?after=1.5','history?limit=0','history?limit=1001','replay?seq=-1','replay?seq=1.5','replay','events?after=NaN']) {
    const response=await f.request(`/api/runs/${a.run.id}/${suffix}`,{},'view');
    assert.equal(response.status,400,suffix);
  }
  assert.equal((await f.request(`/api/runs/${b.run.id}/replay?seq=5`,{},'view')).status,404);
  const other=await (await f.request(`/api/runs/${b.run.id}`,{},'view')).json() as {snapshot:RuntimeFrame};
  assert.equal(other.snapshot.runId,b.run.id);assert.equal(other.snapshot.seq,0);
});

test('completing a recorded run is durable and stops future steps and new commands',async t=>{
  const f=await fixture(t);const {run}=await f.create();
  const command={commandId:'last-command',equipmentId:'P-101',command:'stop'};
  const receipt=f.server.engine.command(run.id,command);
  f.server.engine.stepAll();
  const complete=await f.request(`/api/runs/${run.id}/complete`,{method:'POST'});
  assert.equal(complete.status,200);const saved=await complete.json() as {run:{status:string},snapshot:RuntimeFrame};
  assert.equal(saved.run.status,'completed');
  assert.ok(saved.snapshot.events.some(event=>event.type==='run.completed'));
  f.server.engine.stepAll();assert.deepEqual(f.server.engine.get(run.id),saved);
  const retry=await f.request(`/api/runs/${run.id}/complete`,{method:'POST'});assert.deepEqual(await retry.json(),saved);
  assert.deepEqual(f.server.engine.command(run.id,command),receipt);
  assert.throws(()=>f.server.engine.command(run.id,{...command,commandId:'new-command'}),/completed/i);
  await f.restart();f.server.engine.stepAll();assert.deepEqual(f.server.engine.get(run.id),saved);
});

test('wire validation and offline conversion reject type confusion without changing the last snapshot',()=>{
  const frame:RuntimeFrame={type:'snapshot',runId:'wire-run',seq:0,simTimeMs:0,timestamp:100,equipment:{P:{positionId:'P',instanceId:'P@1',facts:{mode:'running',alarm:'none'},signals:{flow:{type:'number',value:0,unit:'m3/h',timestamp:100,quality:'good'}}}},flows:{},events:[]};
  assert.equal(isFrame(frame),true);
  const converted=offlineFrame(frame);assert.equal(converted.equipment.P.signals.flow.value,null);assert.equal(converted.equipment.P.signals.flow.quality,'offline');
  assert.equal(frame.equipment.P.signals.flow.value,0);assert.equal(frame.equipment.P.signals.flow.quality,'good');
  for(const bad of [NaN,Infinity,'12',false,{}]){
    const malformed=structuredClone(frame);(malformed.equipment.P.signals.flow as any).value=bad;assert.equal(isFrame(malformed),false);
  }
  assert.equal(isFrame({...frame,seq:1.5}),false);
  assert.equal(isFrame({...frame,equipment:{P:{...frame.equipment.P,positionId:'OTHER'}}}),false);
});

test('client drops old updates and wrong runs, then recovers a sequence gap with a full snapshot',async()=>{
  const originalFetch=globalThis.fetch,controllers:ReadableStreamDefaultController<Uint8Array>[]=[];
  const frames:RuntimeFrame[]=[];
  const make=(seq:number,type:RuntimeFrame['type']='update',runId='stream-run'):RuntimeFrame=>({type,runId,seq,simTimeMs:seq*100,timestamp:1000+seq*100,equipment:{P:{positionId:'P',instanceId:'P@1',facts:{mode:'running',alarm:'none'},signals:{rpm:{type:'number',value:1500,unit:'rpm',timestamp:1000+seq*100,quality:'good'}}}},flows:{},events:[]});
  globalThis.fetch=(async(input:RequestInfo|URL)=>{
    const url=String(input);
    if(url.includes('/events?'))return new Response(new ReadableStream<Uint8Array>({start(controller){controllers.push(controller);}}),{headers:{'Content-Type':'text/event-stream'}});
    return Response.json({runs:[]});
  }) as typeof fetch;
  const client=new RuntimeClient();client.onFrame=frame=>frames.push(frame);
  const wait=async(predicate:()=>boolean)=>{for(let i=0;i<120;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('client state did not settle');};
  const send=(index:number,frame:RuntimeFrame)=>controllers[index].enqueue(new TextEncoder().encode(`event: frame\nid: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`));
  try{
    await client.connect({server:'http://localhost:4175',project:'qa'},'qa-memory-token');client.subscribe('stream-run',make(0,'snapshot'));
    await wait(()=>controllers.length===1);send(0,make(0,'snapshot'));send(0,make(1));await wait(()=>client.frame?.seq===1);
    const count=frames.length;send(0,make(1));send(0,make(0));await new Promise(r=>setTimeout(r,20));assert.equal(frames.length,count);
    send(0,make(2,'update','different-run'));await wait(()=>client.status==='reconnecting');assert.equal(client.frame?.runId,'stream-run');assert.equal(client.frame?.seq,1);assert.equal(frames.at(-1)?.equipment.P.signals.rpm.quality,'offline');
    await wait(()=>controllers.length===2);send(1,make(2,'snapshot'));await wait(()=>client.frame?.seq===2);
    send(1,make(4));await wait(()=>client.status==='reconnecting');assert.equal(client.frame?.seq,2);
    await wait(()=>controllers.length===3);send(2,make(4,'snapshot'));send(2,make(5));await wait(()=>client.frame?.seq===5);
    assert.equal(client.status,'connected');assert.equal(frames.at(-1)?.equipment.P.signals.rpm.value,1500);
  }finally{client.disconnect();controllers.forEach(controller=>{try{controller.close();}catch{/* already closed */}});globalThis.fetch=originalFetch;}
});

async function stream(url:string) {
  const abort=new AbortController();
  const response=await fetch(url,{headers:{Authorization:`Bearer ${credentials.view}`},signal:abort.signal});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/text\/event-stream/);
  const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';
  return {
    close(){abort.abort();},
    async next(){
      for(;;){
        const end=buffer.indexOf('\n\n');
        if(end>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=event.match(/^data: (.+)$/m);if(!data)continue;const frame=JSON.parse(data[1]) as RuntimeFrame;const id=event.match(/^id: (\d+)$/m)?.[1];assert.equal(Number(id),frame.seq);assert.match(event,/^event: frame$/m);return frame;}
        const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE frame timeout')),3000);timer.unref();})]);
        assert.equal(chunk.done,false,'SSE closed before expected frame');buffer+=decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,'\n');
      }
    },
  };
}

test('two SSE clients observe one server run and reconnect to a complete snapshot', async t => {
  const f=await fixture(t);const {run}=await f.create();
  const a=await stream(`${f.server.url}/api/runs/${run.id}/events?after=0`);
  const b=await stream(`${f.server.url}/api/runs/${run.id}/events?after=0`);
  let recovered:Awaited<ReturnType<typeof stream>>|undefined;
  try {
    const firstA=await a.next(),firstB=await b.next();assertFrame(firstA);assert.deepEqual(firstA,firstB);assert.equal(firstA.type,'snapshot');
    f.server.engine.stepAll();const nextA=await a.next(),nextB=await b.next();assert.deepEqual(nextA,nextB);assert.equal(nextA.seq,firstA.seq+1);
    a.close();
    for(let i=0;i<3;i++)f.server.engine.stepAll();
    recovered=await stream(`${f.server.url}/api/runs/${run.id}/events?after=${nextA.seq}`);
    const recovery=await recovered.next();assert.equal(recovery.type,'snapshot');assert.equal(recovery.seq,nextA.seq+3);assertFrame(recovery);
  } finally {a.close();b.close();recovered?.close();}
});
