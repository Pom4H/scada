import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunEngine } from '../server/engine';
import { installedBehaviors } from '../server/models';
import { registerComponent } from '../src/core';
import type { CreateRun, RuntimeFrame } from '../src/runtime/protocol';

const source = (extra = '', kind = '', options = '') => `import { tank, pump, valve, outlet, component, connect } from "@scada/core";
const t = tank("T", {x:0,y:0,level:80});
const p = pump("P", {x:250,y:0,rpm:1500,startDelay:0,maintenanceSeconds:0.2,degradationRate:0.1${options}});
const v = valve("V", {x:550,y:0,opening:100});
const o = outlet("O", {x:850,y:0});
${extra}
connect(t.outlet,p.inlet);
${kind ? `connect(p.outlet,f.inlet);connect(f.outlet,v.inlet);` : 'connect(p.outlet,v.inlet);'}
connect(v.outlet,o.inlet);`;
const request = (scenario: CreateRun['scenario'] = 'degradation', text = source()): CreateRun => ({ projectId: 'test-project', source: text, scenario, seed: 1234 });
const value = (frame: RuntimeFrame, id: string, key: string): number | null => frame.equipment[id].signals[key].value as number | null;
const advance = (engine: RunEngine, count: number, id = 'test') => { for (let i = 0; i < count; i++) engine.step(id); return engine.get(id).snapshot; };

test('same epoch, source, seed and command order reproduce every frame including noise', () => {
  const a = new RunEngine(), b = new RunEngine();
  try {
    a.create(request(), {id:'test',epoch:1000}); b.create(request(), {id:'test',epoch:1000});
    for (let i = 0; i < 180; i++) {
      if (i === 120) for (const engine of [a,b]) engine.command('test', {commandId:'service-1',equipmentId:'P',command:'service'});
      if (i === 160) for (const engine of [a,b]) engine.command('test', {commandId:'speed-1',equipmentId:'P',command:'setSpeed',value:-1000});
      assert.deepEqual(a.step('test'), b.step('test'));
    }
  } finally { a.close(); b.close(); }
});
test('impeller fault belongs to pump; downstream outputs change without leaking the cause', () => {
  const normal = new RunEngine(), damaged = new RunEngine();
  try {
    normal.create(request('normal'), {id:'test',epoch:1000}); damaged.create(request(), {id:'test',epoch:1000});
    const healthy = advance(normal,150), failed = advance(damaged,150);
    assert.equal(value(healthy,'P','rpm'),1500); assert.equal(value(failed,'P','rpm'),1500);
    assert.ok(value(failed,'P','flow')! < value(healthy,'P','flow')! * .1);
    assert.equal(value(failed,'P','flow'),value(failed,'V','flow'));
    assert.equal(failed.equipment.P.facts.alarm,'trip');
    const observed = JSON.stringify(damaged.history('test',-1,1000));
    for (const hiddenWord of ['impeller','integrity','broken','scenario','wear','seed']) assert.ok(!observed.includes(hiddenWord), hiddenWord);
    assert.ok(JSON.stringify(damaged.research('test')).includes('impeller.broken'));
  } finally { normal.close(); damaged.close(); }
});
test('service preserves installed instance; replacement changes instance at stable position', () => {
  const engine = new RunEngine();
  try {
    engine.create(request(), {id:'test',epoch:1000}); advance(engine,150);
    engine.command('test',{commandId:'service',equipmentId:'P',command:'service'});
    assert.equal(engine.get('test').snapshot.equipment.P.facts.mode,'maintenance');
    const restored = advance(engine,20);
    assert.equal(restored.equipment.P.instanceId,'P@1'); assert.ok(value(restored,'P','flow')! > 10);
    engine.command('test',{commandId:'replace',equipmentId:'P',command:'replace'});
    assert.equal(engine.get('test').snapshot.equipment.P.positionId,'P'); assert.equal(engine.get('test').snapshot.equipment.P.instanceId,'P@2');
    assert.equal(engine.research('test').run.source,source());
  } finally { engine.close(); }
});
test('filter package participates through generic conductance and installed command handler', () => {
  const engine = new RunEngine();
  try {
    engine.create(request('normal',source('const f=component("filter","F",{x:440,y:0,resistance:0.5});','filter')), {id:'test',epoch:0});
    const before = advance(engine,20); assert.equal(value(before,'F','flow'),6); assert.equal(value(before,'F','differentialPressure'),.5);
    engine.command('test',{commandId:'clean',equipmentId:'F',command:'clean'});
    assert.equal(value(engine.get('test').snapshot,'F','flow'),12);
  } finally { engine.close(); }
});
test('a test-only component installs without editing engine or compiler', () => {
  registerComponent('testRestrictor', {version:'1',label:'Test restrictor',width:60,height:40,fields:{x:{label:'X',default:0,min:-1000,max:1000},y:{label:'Y',default:0,min:-1000,max:1000}},ports:{inlet:{x:0,y:20,direction:'left',role:'in'},outlet:{x:60,y:20,direction:'right',role:'out'}},signals:{observed:{label:'Flow',type:'number',unit:'m3/h'}}});
  const registry = installedBehaviors().register({kind:'testRestrictor',version:'1',assumptions:['Test-only installed restriction'],initialize:()=>({}),advance(){},output:(_state,c)=>({mode:'ready',alarm:'none',signals:{observed:c.transport.flow},process:{boundary:'inline',conductance:.25}})});
  const engine = new RunEngine(':memory:',registry);
  try {
    engine.create(request('normal',source('const f=component("testRestrictor","F",{x:440,y:0});','testRestrictor')), {id:'test',epoch:0});
    assert.equal(value(advance(engine,20),'F','observed'),3);
  } finally { engine.close(); }
});
test('unknown topology is null, confirmed zero is numeric zero, reverse flow does not reverse history', () => {
  const engine = new RunEngine();
  try {
    engine.create(request('normal','import {pump} from "@scada/core"; const p=pump("P",{x:0,y:0,rpm:0});'), {id:'test',epoch:0});
    assert.equal(value(advance(engine,2),'P','flow'),null);
    engine.create(request('normal'), {id:'complete',epoch:0}); advance(engine,20,'complete');
    engine.command('complete',{commandId:'stop',equipmentId:'P',command:'stop'});
    assert.equal(value(advance(engine,20,'complete'),'P','flow'),0);
    engine.command('complete',{commandId:'reverse',equipmentId:'P',command:'setSpeed',value:-1500});
    engine.command('complete',{commandId:'start',equipmentId:'P',command:'start'});
    const reverse=advance(engine,20,'complete'); assert.ok(value(reverse,'P','flow')! < 0); assert.equal(value(reverse,'P','rpm'),-1500);
  } finally { engine.close(); }
});
test('SQLite checkpoint restart preserves PRNG, frames, commands and exact idempotence', () => {
  const dir = mkdtempSync(join(tmpdir(),'scada-model-')), path = join(dir,'runs.sqlite');
  let stored = new RunEngine(path); const uninterrupted = new RunEngine();
  try {
    for (const engine of [stored,uninterrupted]) { engine.create(request(),{id:'test',epoch:42}); advance(engine,90); }
    const command = {commandId:'speed',equipmentId:'P',command:'setSpeed',value:1200};
    const receipt = stored.command('test',command); uninterrupted.command('test',command);
    const recorded = stored.replay('test',30); stored.close(); stored = new RunEngine(path);
    assert.deepEqual(stored.command('test',command),receipt);
    assert.throws(()=>stored.command('test',{...command,value:1400}),/already used/);
    assert.deepEqual(stored.replay('test',30),recorded);
    for (let i=0;i<20;i++) assert.deepEqual(stored.step('test'),uninterrupted.step('test'));
  } finally { stored.close(); uninterrupted.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('input validation rejects executable source, forged command fields and unknown commands', () => {
  const engine = new RunEngine();
  try {
    assert.throws(()=>engine.create(request('normal','fetch("http://127.0.0.1:1")')));
    engine.create(request(),{id:'test',epoch:0});
    assert.throws(()=>engine.command('test',{commandId:'bad',equipmentId:'P',command:'setSpeed',value:Infinity}));
    assert.throws(()=>engine.command('test',{commandId:'bad',equipmentId:'P',command:'__proto__'}));
    assert.throws(()=>engine.command('test',{commandId:'bad',equipmentId:'P',command:'start',value:1}));
    assert.throws(()=>engine.history('test',NaN,1));
    assert.throws(()=>engine.replay('test',-1));
  } finally { engine.close(); }
});
test('completed recording stays completed after restart and accepted command retries remain valid', () => {
  const dir = mkdtempSync(join(tmpdir(),'scada-complete-')), path = join(dir,'runs.sqlite');
  let engine = new RunEngine(path);
  try {
    engine.create(request(),{id:'test',epoch:0}); advance(engine,15);
    const command = {commandId:'stop',equipmentId:'P',command:'stop'};
    const receipt = engine.command('test',command);
    const completed = engine.complete('test');
    assert.equal(completed.run.status,'completed'); assert.equal(completed.snapshot.events[0].type,'run.completed');
    engine.stepAll(); assert.deepEqual(engine.complete('test'),completed);
    engine.close(); engine = new RunEngine(path); engine.stepAll();
    assert.deepEqual(engine.get('test'),completed); assert.deepEqual(engine.command('test',command),receipt);
    assert.throws(()=>engine.command('test',{commandId:'start',equipmentId:'P',command:'start'}),/completed/);
  } finally { engine.close(); rmSync(dir,{recursive:true,force:true}); }
});
