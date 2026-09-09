import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeClient, isFrame } from '../src/runtime/client';
import { configurationJSON, type RuntimeFrame } from '../src/runtime/protocol';
import { compile } from '../src/source';
import { booster } from '../src/examples';
import { dslCompletions } from '../src/completion';
import { registerComponent } from '../src/core';
import { RunEngine } from '../server/engine';
import { BehaviorRegistry } from '../server/behavior';
import { StorageError } from '../server/store';
import { GitProject } from '../server/project';
import { startServer } from '../server/index';

const credentials = { view: 'review-view', operator: 'review-operator', research: 'review-research' };
const source = booster;
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'scada-review-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Review'); git('config', 'user.email', 'review@localhost');
  await writeFile(join(directory, 'scada.project.json'), JSON.stringify({ version: 1, id: 'pump-demo', entry: 'scene.ts', files: ['scene.ts', 'README.md'] }));
  await writeFile(join(directory, 'scene.ts'), source); await writeFile(join(directory, 'README.md'), '# Operator notes');
  await writeFile(join(directory, '.env'), 'SECRET=must-not-leak');
  git('add', 'scada.project.json', 'scene.ts', 'README.md'); git('commit', '-m', 'initial');
  return { directory, git, revision: git('rev-parse', 'HEAD') };
}

test('heartbeat cannot keep frozen telemetry good; new model time recovers; completed runs do not expire', async () => {
  const engine = new RunEngine(); const detail = engine.create({ projectId: 'test', source, scenario: 'normal' });
  let stream: ServerResponse | undefined;
  const http = createServer((req, res) => {
    if (req.url?.startsWith('/api/runs?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ runs: [detail.run] })); }
    else {
      stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify(detail.snapshot)}\n\n`);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 15); res.once('close', () => clearInterval(timer));
    }
  });
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  const client = new RuntimeClient({ freshnessMs: 90, transportTimeoutMs: 500 }); let displayed: RuntimeFrame | null = null;
  client.onFrame = frame => { displayed = frame; };
  try {
    await client.connect({ server: `http://127.0.0.1:${(http.address() as {port:number}).port}`, project: 'test' }, 'token');
    client.subscribe(detail.run.id, detail.snapshot);
    await delay(240); assert.equal(client.status, 'stale'); assert.equal((displayed as unknown as RuntimeFrame).equipment['P-101'].signals.rpm.quality, 'stale');
    const next = engine.step(detail.run.id); stream!.write(`data: ${JSON.stringify(next)}\n\n`);
    await delay(20); assert.equal(client.status, 'connected');
    const complete = engine.complete(detail.run.id).snapshot; complete.type = 'update'; stream!.write(`data: ${JSON.stringify(complete)}\n\n`);
    await delay(240); assert.equal(client.status, 'connected'); assert.equal(client.frame?.runStatus, 'completed');
    client.unsubscribe(); assert.ok(client.config); assert.equal(client.frame, null); assert.equal((await client.runs()).length, 1);
  } finally { client.disconnect(); stream?.destroy(); await new Promise<void>(ok => http.close(() => ok())); engine.close(); }
});

test('layout metadata is excluded from identity; behavior edits are not', () => {
  const identity = configurationJSON(compile(source).scene);
  assert.equal(configurationJSON(compile(source.replace('x: 325', 'x: 335')).scene), identity);
  assert.equal(configurationJSON(compile(source + '\n// harmless comment').scene), identity);
  assert.notEqual(configurationJSON(compile(source.replace('rpm: 1500', 'rpm: 1200')).scene), identity);
});

test('a failing model is durably isolated; following runs keep stepping; shared storage failure propagates', () => {
  registerComponent('reviewProbe', { version: '1', label: 'Probe', width: 1, height: 1, fields: { fail: {label:'fail',default:false} }, ports: {}, signals: { n: {label:'N',type:'number',unit:'count'} } });
  const registry = new BehaviorRegistry().register({ kind: 'reviewProbe', version: '1', assumptions: ['test'], initialize: () => ({ n: 0 }), advance(state, c) { if (c.node.props.fail) throw new Error('private model detail'); state.n = Number(state.n) + 1; }, output: state => ({ mode: 'ready', alarm: 'none', signals: { n: Number(state.n) } }) });
  const engine = new RunEngine(':memory:', registry);
  try {
    const bad = engine.create({ projectId: 'a', source: 'import {component} from "@scada/core"; const p=component("reviewProbe","A",{fail:true});', scenario: 'normal' }).run;
    const good = engine.create({ projectId: 'b', source: 'import {component} from "@scada/core"; const p=component("reviewProbe","B",{fail:false});', scenario: 'normal' }).run;
    const errors: unknown[] = []; engine.stepAll(error => errors.push(error));
    assert.equal(engine.get(bad.id).run.status, 'failed'); assert.equal(engine.get(good.id).snapshot.equipment.B.signals.n.value, 1); assert.equal(errors.length, 1);
    assert.ok(isFrame(engine.get(bad.id).snapshot)); assert.equal(engine.get(bad.id).snapshot.equipment.A.signals.n.quality, 'bad'); assert.ok(!JSON.stringify(engine.get(bad.id)).includes('private model detail'));
    engine.stepAll(); assert.equal(engine.get(good.id).run.seq, 2); assert.equal(engine.get(bad.id).run.seq, 1);
    engine.store.persist = () => { throw new StorageError(new Error('disk full')); };
    assert.throws(() => engine.stepAll(), StorageError); assert.equal(engine.get(good.id).run.seq, 2);
  } finally { engine.close(); }
});

test('history ranges are exact, indexed, bounded; overview is signal-specific and bounded', () => {
  const engine = new RunEngine();
  try {
    const { run } = engine.create({ projectId: 'history', source, scenario: 'normal' });
    for (let i = 0; i < 1400; i++) engine.step(run.id);
    const range = { fromMs: 100_000, toMs: 105_000, untilSeq: 1400 };
    const page = engine.history(run.id, -1, 500, range);
    assert.equal(page.frames.length, 51); assert.equal(page.frames[0].seq, 1000); assert.equal(page.frames.at(-1)?.seq, 1050);
    const overview = engine.trend(run.id, { equipmentId: 'P-101', signal: 'rpm' }, { fromMs: 0, toMs: 140_000, untilSeq: 1400 }, 40);
    assert.ok(overview.points.length <= 40); assert.equal(overview.unit, 'rpm'); assert.equal(overview.points.at(-1)?.value, 1500);
    const temperature = engine.trend(run.id, { equipmentId: 'P-101', signal: 'temperature' }, range, 40);
    assert.equal(temperature.unit, '°C'); assert.notDeepEqual(temperature.points, overview.points);
    assert.throws(() => engine.trend(run.id, { equipmentId: 'not-an-id', signal: 'rpm' }, range));
  } finally { engine.close(); }
});

test('Git reload ignores the working tree, rejects broken commits, survives restart and accepts rollback', async () => {
  const repo = await repository(); let project: GitProject | undefined;
  try {
    project = await new GitProject({ repository: repo.directory }).start();
    assert.equal(project.get('pump-demo').project?.revision, repo.revision);
    assert.deepEqual(project.get('pump-demo').project?.files.map(f => f.path), ['scene.ts', 'README.md']);
    assert.ok(!JSON.stringify(project.get('pump-demo')).includes('SECRET'));
    await writeFile(join(repo.directory, 'scene.ts'), 'while(true){}'); await project.reload();
    assert.equal(project.get('pump-demo').project?.revision, repo.revision);
    repo.git('add', 'scene.ts'); repo.git('commit', '-m', 'bad revision'); const bad = repo.git('rev-parse', 'HEAD'); await project.reload();
    assert.equal(project.get('pump-demo').project?.revision, repo.revision); assert.equal(project.get('pump-demo').rejectedRevision, bad);
    await project.close(); project = await new GitProject({ repository: repo.directory }).start();
    assert.equal(project.get('pump-demo').project?.revision, repo.revision);
    await writeFile(join(repo.directory, 'scene.ts'), source.replace('rpm: 1500', 'rpm: 1100')); repo.git('add', 'scene.ts'); repo.git('commit', '-m', 'good revision'); await project.reload();
    assert.equal(project.get('pump-demo').project?.revision, repo.git('rev-parse', 'HEAD')); assert.equal(project.get('pump-demo').error, undefined);
    repo.git('update-ref', 'refs/heads/main', repo.revision); await project.reload(); assert.equal(project.get('pump-demo').project?.revision, repo.revision);
  } finally { await project?.close(); await rm(repo.directory, {recursive:true,force:true}); }
});

test('Git saves use compare-and-swap, never change the working tree, and reject invalid drafts and symlinks', async () => {
  const repo = await repository(); const project = await new GitProject({ repository: repo.directory, writable: true }).start();
  try {
    const changed = source + '\n// saved through Git';
    const saved = await project.save('pump-demo', { baseRevision: repo.revision, path: 'scene.ts', content: changed, message: 'Edit scene' });
    assert.notEqual(saved.project?.revision, repo.revision); assert.equal(saved.project?.files[0].content, changed);
    assert.equal(repo.git('show', `${repo.revision}:scene.ts`), source.trim());
    await assert.rejects(project.save('pump-demo', { baseRevision: repo.revision, path: 'scene.ts', content: source, message: 'stale writer' }), /revision changed/);
    const head = repo.git('rev-parse', 'HEAD');
    await assert.rejects(project.save('pump-demo', { baseRevision: head, path: 'scene.ts', content: 'fetch("https://example.com")', message: 'invalid' })); assert.equal(repo.git('rev-parse', 'HEAD'), head);
    await writeFile(join(repo.directory, 'scada.project.json'), JSON.stringify({version:1,id:'pump-demo',entry:'scene.ts',files:['scene.ts','linked.md']}));
    await symlink(join(repo.directory, '.env'), join(repo.directory, 'linked.md'));
    repo.git('add','scada.project.json','linked.md'); repo.git('commit','-m','symlink candidate'); await project.reload();
    assert.equal(project.get('pump-demo').project?.revision, head); assert.ok(project.get('pump-demo').error);
  } finally { await project.close(); await rm(repo.directory,{recursive:true,force:true}); }
});

test('authenticated project delivery and pinned run revisions survive Git reload and server restart', async () => {
  const repo = await repository(); const database = join(repo.directory, 'runs.sqlite');
  let app = await startServer({ port: 0, dataPath: database, tokens: credentials, autoTick: false, project: { repository: repo.directory, writable: true } });
  const call = async (path: string, body?: unknown, token = credentials.operator) => {
    const response = await fetch(app.url+path, { method: body ? 'POST' : 'GET', headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as any };
  };
  try {
    assert.equal((await fetch(app.url+'/api/projects')).status, 401);
    const delivered = await call('/api/projects/pump-demo', undefined, credentials.view); assert.equal(delivered.data.project.revision, repo.revision);
    const input = {projectId:'pump-demo', source, scenario:'normal', projectRevision:repo.revision,projectEntry:'scene.ts'};
    const created = await call('/api/runs',input); assert.equal(created.status,201); const id=created.data.run.id;
    assert.equal((await call('/api/projects/pump-demo',{baseRevision:repo.revision,path:'scene.ts',content:source,message:'denied'},credentials.view)).status,403);
    const changed = source.replace('rpm: 1500','rpm: 1000');
    assert.equal((await call('/api/projects/pump-demo',{baseRevision:repo.revision,path:'scene.ts',content:changed,message:'new revision'})).status,200);
    assert.equal((await call('/api/runs',input)).status,409);
    assert.equal((await call(`/api/runs/${id}/project`)).data.project.revision,repo.revision);
    app.engine.step(id); const seq=app.engine.get(id).run.seq;
    await app.close(); app=await startServer({port:0,dataPath:database,tokens:credentials,autoTick:false,project:{repository:repo.directory}});
    assert.equal(app.engine.get(id).run.seq,seq); assert.equal((await call(`/api/runs/${id}/project`)).data.project.files[0].content,source);
  } finally { await app.close(); await rm(repo.directory,{recursive:true,force:true}); }
});


test('metadata completions include extension fields, enums, aliased factories and named ports', () => {
  const partial = 'import {component} from "@scada/core"; const f=component("filter","F",{ res';
  assert.ok(dslCompletions(partial,partial.length).some(option=>option.label==='resistance'));
  const alias = 'import {pump as driver} from "@scada/core"; const p=driver("P",{ degr';
  assert.ok(dslCompletions(alias,alias.length).some(option=>option.label==='degradationRate'));
  const choices = 'import {pump} from "@scada/core"; const p=pump("P",{quality:"g';
  assert.ok(dslCompletions(choices,choices.length).some(option=>option.label==='good'));
  const member = source+'\nmotor.';
  assert.ok(dslCompletions(member,member.length,compile(source).scene).some(option=>option.label==='outlet'));
});
