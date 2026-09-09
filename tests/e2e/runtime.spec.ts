import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { booster } from '../../src/examples';
import type { RuntimeFrame } from '../../src/runtime/protocol';

const origin='http://127.0.0.1:4188';
const proxyOrigin='http://127.0.0.1:4189';
const operator='qa-operator-482615-stage',viewToken='qa-view-only-137246-stage';
const source=(run?:string)=>`import {runtime} from '@scada/core';
runtime({server:'${origin}',project:'qa-browser'${run?`,run:'${run}'`:''}});
// Synthetic QA scenario: accelerated degradation, no connection to equipment.
${booster.replace('rpm: 1500','rpm: 1500, degradationRate: 0.1, maintenanceSeconds: 1, startDelay: 0.1')}`;
const state=(page:Page)=>page.evaluate(()=>{
  const api=(window as any).__scada;
  return {source:api.source,error:api.error,runtime:{status:api.runtime.status,frame:api.runtime.frame as RuntimeFrame|null,runId:api.runtime.runId}};
});
const frame=async(page:Page)=>(await state(page)).runtime.frame!;
async function open(page:Page,text:string){await page.goto(`./#code=${Buffer.from(text).toString('base64url')}`);await page.waitForFunction(()=>!!(window as any).__scada?.runtime);expect((await state(page)).source).toBe(text);expect((await state(page)).error).toBeNull();}
async function connect(page:Page,token=operator){await page.locator('#server-token').fill(token);await page.locator('#connect-server').click();}
async function create(request:APIRequestContext,scenario:'normal'|'degradation'='degradation'){
  const response=await request.post(`${origin}/api/runs`,{headers:{Authorization:`Bearer ${operator}`},data:{projectId:'qa-browser',label:`QA ${scenario}`,source:source(),scenario,seed:42}});
  expect(response.status()).toBe(201);return (await response.json()).run as {id:string};
}
const pageErrors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const errors:string[]=[];pageErrors.set(page,errors);page.on('pageerror',e=>errors.push(e.message));});
test.afterEach(async({page},info)=>{if(!page.isClosed())await info.attach('screen',{body:await page.screenshot(),contentType:'image/png'});expect(pageErrors.get(page)??[]).toEqual([]);});

test('shared TS shows destination before connection; telemetry and credentials preserve source and undo',async({page})=>{
  const network:string[]=[];page.on('request',request=>{if(request.url().includes('/api/'))network.push(request.url());});
  const original=source();await open(page,original);
  await expect(page.locator('#server-address')).toHaveValue(origin);
  await page.waitForTimeout(250);expect(network).toEqual([]);
  const changed=original+'\n// Exact source and undo checkpoint: насос → вода';
  await page.evaluate(text=>(window as any).__scada.setSource(text),changed);
  await connect(page);
  await expect(page.locator('#create-run')).toBeEnabled();
  await page.locator('#scenario-kind').selectOption('degradation');
  await page.locator('#create-run').click();
  await expect.poll(async()=>!!(await state(page)).runtime.frame).toBe(true);
  const first=await frame(page);
  await expect.poll(async()=>(await frame(page)).seq).toBeGreaterThan(first.seq+6);
  expect((await state(page)).source).toBe(changed);
  const storage=await page.evaluate(()=>Object.entries(localStorage));
  expect(storage.some(([,value])=>value.includes(operator))).toBe(false);
  expect(storage.find(([key])=>key==='scada.source.v1')?.[1]).toBe(changed);
  expect(page.url()).not.toContain(operator);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await page.locator('#share').click();
  const shared=await page.evaluate(()=>navigator.clipboard.readText());
  const sharedSource=Buffer.from(new URL(shared).hash.slice(6),'base64url').toString('utf8');
  expect(sharedSource).toContain(first.runId);expect(sharedSource).not.toContain(operator);expect(shared).not.toContain(operator);
  const opened=await page.context().newPage();
  try{await opened.goto(shared);await opened.waitForFunction(()=>!!(window as any).__scada?.runtime);expect((await state(opened)).source).toBe(sharedSource);await expect(opened.locator('#server-token')).toHaveValue('');expect((await state(opened)).runtime.runId).toBeNull();}finally{await opened.close();}
  expect((await state(page)).source).toBe(changed);
  await page.locator('#undo').click();expect((await state(page)).source).toBe(original);
  await page.locator('#redo').click();expect((await state(page)).source).toBe(changed);
});

test('two clients share a run; visual pause and tab closure leave execution alive; offline restores safely',async({page,browser,request})=>{
  const run=await create(request);const text=source(run.id);await open(page,text);await connect(page);
  await expect.poll(async()=>(await state(page)).runtime.frame?.runId).toBe(run.id);
  const context=await browser.newContext({viewport:{width:1440,height:900}}),other=await context.newPage();
  try {
    const proxySource=text.replace(origin,proxyOrigin);
    await open(other,proxySource);await connect(other,viewToken);
    await expect.poll(async()=>(await state(other)).runtime.frame?.runId).toBe(run.id);
    await expect.poll(async()=>{
      const [a,b]=await Promise.all([frame(page),frame(other)]);
      return a.seq===b.seq && JSON.stringify(a.equipment)===JSON.stringify(b.equipment) && JSON.stringify(a.flows)===JSON.stringify(b.flows);
    }).toBe(true);
    await page.locator('#pause').click();
    const rotor=page.locator('[data-node="P-101"] [data-part="rotor"]');
    const frozen=await rotor.getAttribute('transform'),before=(await frame(page)).seq;
    await expect.poll(async()=>(await frame(page)).seq).toBeGreaterThan(before+5);
    expect(await rotor.getAttribute('transform')).toBe(frozen);
    expect((await request.post(proxyOrigin+'/__qa__/cut',{headers:{'X-SCADA-QA':'network-fixture'}})).ok()).toBe(true);
    await expect(other.locator('#flow-readout')).toHaveText('—');
    await expect(other.locator('#connection-status')).not.toHaveText('');
    const disconnectedAt=(await frame(page)).seq;
    await expect.poll(async()=>(await frame(page)).seq).toBeGreaterThan(disconnectedAt+5);
    expect((await request.post(proxyOrigin+'/__qa__/restore',{headers:{'X-SCADA-QA':'network-fixture'}})).ok()).toBe(true);
    await expect.poll(async()=>(await state(other)).runtime.frame?.seq??-1).toBeGreaterThan(disconnectedAt+5);
    await expect(other.locator('#flow-readout')).not.toHaveText('—');
    expect((await state(other)).source).toBe(proxySource);
    const closingAt=(await frame(other)).seq;await page.close();
    await expect.poll(async()=>(await frame(other)).seq).toBeGreaterThan(closingAt+5);
  } finally {await request.post(proxyOrigin+'/__qa__/restore',{headers:{'X-SCADA-QA':'network-fixture'}});await context.close();}
});

test('recorded replay and comparison read history while the live run continues',async({page,request})=>{
  const active=await create(request),reference=await create(request,'normal');
  await open(page,source(active.id));await connect(page);
  await expect.poll(async()=>(await state(page)).runtime.frame?.seq??-1).toBeGreaterThan(12);
  const text=(await state(page)).source;
  await page.locator('#history-load').click();
  await expect(page.locator('#replay-position')).toBeEnabled();
  await page.locator('#replay-position').evaluate((input:HTMLInputElement)=>{input.value=input.min||'0';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect.poll(async()=>(await frame(page)).seq).toBeLessThan(12);
  const recorded=(await frame(page)).seq;
  await page.locator('#replay-play').click();
  await expect.poll(async()=>(await frame(page)).seq).toBeGreaterThan(recorded);
  await page.locator('#replay-play').click();
  const paused=(await frame(page)).seq;
  const latest=await request.get(`${origin}/api/runs/${active.id}`,{headers:{Authorization:`Bearer ${viewToken}`}});
  expect((await latest.json()).snapshot.seq).toBeGreaterThan(paused);
  await page.locator('#replay-live').click();
  await expect.poll(async()=>(await frame(page)).seq).toBeGreaterThan(paused);
  await page.locator('#compare-run').selectOption(reference.id);
  const comparisonResponse=page.waitForResponse(response=>response.url().includes(`/api/runs/${reference.id}/trend`));
  await page.locator('#compare-history').click();expect((await comparisonResponse).ok()).toBe(true);
  expect((await state(page)).source).toBe(text);
  expect((await frame(page)).runId).toBe(active.id);
});

test('degradation is observable; service restores one instance; replacement creates another',async({page,request},info)=>{
  const run=await create(request);await open(page,source(run.id));await connect(page);
  await expect.poll(async()=>(await state(page)).runtime.frame?.equipment['P-101']?.signals.rpm.value??0).toBe(1500);
  const initial=await frame(page),instance=initial.equipment['P-101'].instanceId;
  await expect.poll(async()=>(await frame(page)).equipment['P-101'].signals.vibration.value as number,{timeout:18000}).toBeGreaterThan(5);
  const degraded=await frame(page);
  expect(degraded.equipment['P-101'].signals.rpm.value).toBe(1500);
  expect(degraded.equipment['P-101'].signals.flow.value as number).toBeLessThan(initial.equipment['P-101'].signals.flow.value as number);
  await expect(page.locator('[data-node="P-101"]')).toHaveAttribute('data-alarm','warning');
  await info.attach('degradation',{body:await page.screenshot(),contentType:'image/png'});
  await page.locator('[data-node="P-101"] .node-hit').click();
  await page.locator('#service-equipment').click();
  await expect.poll(async()=>(await frame(page)).equipment['P-101'].facts.mode).toBe('maintenance');
  await expect.poll(async()=>(await frame(page)).equipment['P-101'].signals.flow.value as number).toBeGreaterThan(degraded.equipment['P-101'].signals.flow.value as number);
  expect((await frame(page)).equipment['P-101'].instanceId).toBe(instance);
  await page.locator('#replace-equipment').click();
  await expect.poll(async()=>(await frame(page)).equipment['P-101'].instanceId).not.toBe(instance);
  expect((await frame(page)).equipment['P-101'].positionId).toBe('P-101');
  expect((await state(page)).source).toBe(source(run.id));
});

test('switching runs cannot combine histories or apply another project configuration',async({page,request})=>{
  const a=await create(request),b=await create(request,'normal');await open(page,source(a.id));await connect(page);
  await expect.poll(async()=>(await state(page)).runtime.frame?.seq??-1).toBeGreaterThan(5);
  await page.locator('#history-load').click();
  await page.locator('#run-select').selectOption(b.id);
  await expect.poll(async()=>(await frame(page)).runId).toBe(b.id);
  const bFrame=await frame(page);expect(bFrame.equipment['P-101'].facts.alarm).toBe('none');
  const before=(await state(page)).source;
  await page.evaluate(text=>(window as any).__scada.setSource(text),before.replace('rpm: 1500','rpm: 900'));
  await expect.poll(async()=>{
    const s=await state(page);return s.runtime.status==='connected' && s.runtime.runId===null && s.runtime.frame===null;
  }).toBe(true);
  await page.locator('#undo').click();expect((await state(page)).source).toBe(before);
});

test('editing equipment while run creation is pending cannot attach the old configuration',async({page})=>{
  await open(page,source());await connect(page);await expect(page.locator('#create-run')).toBeEnabled();
  let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),intercepted=new Promise<void>(resolve=>{entered=resolve;});
  await page.route(`${origin}/api/runs`,async route=>{if(route.request().method()==='POST'){entered();await blocked;}await route.continue();});
  const response=page.waitForResponse(response=>response.url()===`${origin}/api/runs`&&response.request().method()==='POST');
  await page.locator('#create-run').click();await intercepted;
  const changed=source().replace('rpm: 1500','rpm: 900');await page.evaluate(text=>(window as any).__scada.setSource(text),changed);
  release();expect((await response).status()).toBe(201);
  await expect(page.locator('#toast')).toContainText('Схема изменилась');
  expect((await state(page)).runtime.runId).toBeNull();expect((await state(page)).runtime.frame).toBeNull();
  expect((await state(page)).source).toBe(changed);
});

test('finishing the recording stops server steps and keeps replay available',async({page,request})=>{
  const run=await create(request,'normal');await open(page,source(run.id));await connect(page);
  await expect.poll(async()=>(await state(page)).runtime.frame?.seq??-1).toBeGreaterThan(4);
  const completed=page.waitForResponse(response=>response.url().endsWith(`/api/runs/${run.id}/complete`));
  await page.locator('#complete-run').click();expect((await completed).ok()).toBe(true);
  await expect(page.locator('#complete-run')).toBeDisabled();
  const recorded=await frame(page);expect(recorded.events.some(event=>event.type==='run.completed')).toBe(true);
  await page.waitForTimeout(500);expect((await frame(page)).seq).toBe(recorded.seq);
  await page.locator('#history-load').click();await expect(page.locator('#replay-play')).toBeEnabled();
  expect((await state(page)).source).toBe(source(run.id));
});

test('3D loads on demand and reduced motion preserves a usable keyboard editor',async({browser,request})=>{
  const run=await create(request,'normal');const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await open(page,source(run.id));await connect(page);
    await expect.poll(async()=>(await state(page)).runtime.frame?.equipment['P-101']?.signals.rpm.value??0).toBe(1500);
    await expect(page.locator('#scene3d canvas')).toHaveCount(0);
    const before=await page.locator('[data-node="P-101"] [data-part="rotor"]').getAttribute('transform');
    await page.waitForTimeout(250);expect(await page.locator('[data-node="P-101"] [data-part="rotor"]').getAttribute('transform')).toBe(before);
    const scriptsBefore=await page.evaluate(()=>performance.getEntriesByType('resource').filter(x=>x.name.includes('.js')).length);
    await page.locator('#view-3d').click();await expect(page.locator('#scene3d canvas')).toBeVisible();
    expect(await page.evaluate(()=>performance.getEntriesByType('resource').filter(x=>x.name.includes('.js')).length)).toBeGreaterThan(scriptsBefore);
    await expect(page.locator('#scene3d')).toHaveAttribute('data-run-id',run.id);
    const rendered=await page.locator('#scene3d [data-node3d]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-node3d')).sort());
    expect(rendered).toEqual(Object.keys((await frame(page)).equipment).sort());
    await expect(page.locator('#scene3d [data-node3d="P-101"]')).toHaveAttribute('data-instance-id',(await frame(page)).equipment['P-101'].instanceId);
    await page.locator('#view-2d').click();await expect(page.locator('#scene')).toBeVisible();
    const original=(await state(page)).source;
    await page.locator('[data-node="P-101"] .node-hit').click();await page.keyboard.press('ArrowRight');
    expect((await state(page)).source).not.toBe(original);
    await page.locator('#undo').click();expect((await state(page)).source).toBe(original);
    expect(errors).toEqual([]);
  } finally {await context.close();}
});
