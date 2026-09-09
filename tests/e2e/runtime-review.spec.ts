import { test, expect, type Page } from '@playwright/test';
import { startServer } from '../../server/index';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const text = `import {tank,pump,outlet,connect} from '@scada/core';
const a=tank('T-1',{x:40,y:100});
const p=pump('P-1',{x:325,y:188,rpm:1500,startDelay:0});
const o=outlet('OUT-1',{x:700,y:150});
connect(a.outlet,p.inlet);connect(p.outlet,o.inlet);
const b=tank('T-2',{x:40,y:500});
const q=pump('P-2',{x:325,y:588,rpm:750,startDelay:0});
const z=outlet('OUT-2',{x:700,y:550});
connect(b.outlet,q.inlet);connect(q.outlet,z.inlet);`;
const tokens = {view:'project-view-test',operator:'project-operator-test',research:'project-research-test'};
let directory: string, app: Awaited<ReturnType<typeof startServer>>;
const git = (...args: string[]) => execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const state = (page: Page) => page.evaluate(() => {
  const a=(window as any).__scada;
  return {source:a.source,error:a.error,runId:a.runtime.runId,status:a.runtime.status,frame:a.runtime.frame};
});
const errors = new WeakMap<Page,string[]>();
test.beforeEach(async ({page}) => {
  errors.set(page,[]); page.on('pageerror',e=>errors.get(page)!.push(e.message));
  directory=await mkdtemp(join(tmpdir(),'scada-project-browser-'));
  git('init','-b','main');git('config','user.name','SCADA browser test');git('config','user.email','test@localhost');
  await writeFile(join(directory,'scada.project.json'),JSON.stringify({version:1,id:'pump-demo',entry:'scene.ts',files:['scene.ts','README.md']}));
  await writeFile(join(directory,'scene.ts'),text);await writeFile(join(directory,'README.md'),'# Equipment project\nOperator notes.');
  await writeFile(join(directory,'.env'),'SECRET=never-delivered');
  git('add','scada.project.json','scene.ts','README.md');git('commit','-m','Initial project');
  app=await startServer({port:0,dataPath:join(directory,'runs.sqlite'),staticDir:resolve('dist'),tokens,project:{repository:directory,pollMs:100,writable:true}});
  await page.goto(app.url+'/scada/');
  await page.locator('#server-address').fill(app.url);
  await page.locator('#server-token').fill(tokens.operator);await page.locator('#connect-server').click();
  await expect.poll(async()=>(await state(page)).source).toBe(text);
  await expect(page.locator('#project-sync')).toBeVisible();
});
test.afterEach(async ({page},info) => {
  try {
    if(!page.isClosed()) await info.attach('project-workspace',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
    expect(errors.get(page)??[]).toEqual([]);
  } finally {await app?.close();await rm(directory,{recursive:true,force:true});}
});
async function run(page:Page) {
  await page.locator('#create-run').click();await expect.poll(async()=>(await state(page)).runId).toBeTruthy();
  return (await state(page)).runId as string;
}
async function commit(source:string) {await writeFile(join(directory,'scene.ts'),source);git('add','scene.ts');git('commit','-m','Update project');return git('rev-parse','HEAD');}

test('server delivers allowlisted files; browser saves a CAS Git commit without touching undo or credentials',async({page})=>{
  const revision=git('rev-parse','HEAD'),id=await run(page);
  expect(app.engine.get(id).run.projectRevision).toBe(revision);
  await page.locator('#project-files').click();await page.locator('#project-file-list').selectOption('README.md');
  await expect(page.locator('#project-file-preview')).toHaveValue('# Equipment project\nOperator notes.');
  await expect(page.locator('#project-file-list option')).toHaveCount(2);await page.locator('#project-close').click();
  const draft=text+'\n// Saved from the developer workspace';
  await page.evaluate(value=>(window as any).__scada.setSource(value),draft);
  await expect(page.locator('#project-save')).toBeEnabled();await page.locator('#project-save').click();
  await expect.poll(()=>git('rev-parse','HEAD')).not.toBe(revision);
  expect(git('show','HEAD:scene.ts')).toBe(draft);
  expect((await state(page)).runId).toBe(id);expect(app.engine.get(id).run.projectRevision).toBe(revision);
  await page.locator('#undo').click();expect((await state(page)).source).toBe(text);expect((await state(page)).status).toBe('connected');
  const storage=await page.evaluate(()=>JSON.stringify(Object.entries(localStorage)));
  expect(storage).not.toContain(tokens.operator);expect(storage).not.toContain('never-delivered');
});

test('compatible Git hot reload retains a live run; incompatible update preserves and then detaches a draft',async({page})=>{
  const id=await run(page),moved=text.replace('x:325,y:188','x:345,y:188');
  const revision=await commit(moved);
  await expect.poll(async()=>(await state(page)).source).toBe(moved);
  expect((await state(page)).runId).toBe(id);expect((await state(page)).status).toBe('connected');
  await expect(page.locator('#project-revision')).toContainText(revision.slice(0,8));
  const draft=moved+'\n// Do not discard this local work';await page.evaluate(value=>(window as any).__scada.setSource(value),draft);
  const changed=moved.replace('rpm:1500','rpm:1100');await commit(changed);
  await expect(page.locator('#project-apply')).toBeVisible();expect((await state(page)).source).toBe(draft);
  await page.locator('#project-apply').click();await expect.poll(async()=>(await state(page)).source).toBe(changed);
  expect((await state(page)).status).toBe('connected');expect((await state(page)).runId).toBeNull();
  expect(app.engine.get(id).run.status).toBe('running');
  const drafts=await page.evaluate(()=>localStorage.getItem('scada.project.drafts.v1'));expect(drafts).toContain('Do not discard this local work');
});

test('temporary TS error blocks commands but retains stream; position edits preserve run and auth',async({page})=>{
  const id=await run(page);await expect.poll(async()=>(await state(page)).frame?.seq??0).toBeGreaterThan(3);
  await page.evaluate(value=>(window as any).__scada.setSource(value),text+'\nconst incomplete =');
  await expect.poll(async()=>(await state(page)).error).toBeTruthy();const before=(await state(page)).frame.seq;
  await expect(page.locator('#service-equipment')).toBeDisabled();
  await expect.poll(async()=>(await state(page)).frame.seq).toBeGreaterThan(before+3);
  expect((await state(page)).status).toBe('connected');expect((await state(page)).runId).toBe(id);
  await page.locator('#undo').click();await expect(page.locator('#service-equipment')).toBeEnabled();
  await page.evaluate(()=>(window as any).__scada.select('P-1'));
  await page.locator('[data-node="P-1"] .node-hit').click();await page.keyboard.press('ArrowRight');
  expect((await state(page)).source).not.toBe(text);expect((await state(page)).runId).toBe(id);
  await page.locator('#undo').click();expect((await state(page)).source).toBe(text);expect((await state(page)).runId).toBe(id);
});

test('selected signal drives overview; playback retains graph DOM and uses bounded history requests',async({page})=>{
  const id=await run(page);for(let i=0;i<80;i++)app.engine.step(id);
  await page.evaluate(()=>(window as any).__scada.select('P-2'));
  await page.locator('#trend-signal').selectOption('rpm');
  await expect(page.locator('#flow-label')).toContainText('P-2');await expect(page.locator('#flow-readout')).toHaveText('750.0');
  await page.locator('#history-window').fill('1');
  const ranges:string[]=[];page.on('request',request=>{if(request.url().includes('/history?'))ranges.push(request.url());});
  await page.locator('#history-load').click();await expect(page.locator('#replay-play')).toBeEnabled();
  await page.evaluate(()=>{(window as any).__plot=document.querySelector('#trend path');});
  await page.locator('#replay-play').click();
  await expect.poll(async()=>(await state(page)).frame.seq).toBeGreaterThan(15);
  expect(await page.evaluate(()=>document.querySelector('#trend path')===(window as any).__plot)).toBe(true);
  expect(ranges.length).toBeGreaterThan(1);
  for(const url of ranges){const p=new URL(url).searchParams;expect(Number(p.get('toMs'))-Number(p.get('fromMs'))).toBeLessThanOrEqual(1000);expect(p.has('untilSeq')).toBe(true);}
  await page.locator('#replay-play').click();await expect(page.locator('#trend-label')).toContainText('P-2 · rpm');
});

test('invalid deployment keeps the previous scene and live run; responsive workspace is usable',async({page},info)=>{
  const id=await run(page),originalRevision=git('rev-parse','HEAD');await commit('while(true){}');
  await expect(page.locator('#project-status')).toContainText('последняя корректная');
  expect((await state(page)).source).toBe(text);expect((await state(page)).runId).toBe(id);
  expect(app.project!.get('pump-demo').project?.revision).toBe(originalRevision);
  const before=(await state(page)).frame.seq;await expect.poll(async()=>(await state(page)).frame.seq).toBeGreaterThan(before+2);
  await info.attach('desktop-project',{body:await page.screenshot(),contentType:'image/png'});
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#connect-server')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await info.attach('mobile-project',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});
