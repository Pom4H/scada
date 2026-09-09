import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, patchFields, applyChanges, editable, removeObject, appendEquipment, appendConnection, appendTap, formatSource } from '../src/source';
import { catalog, simulate, worldPort, pump, valve, connect } from '../src/core';
import { layout, segmentClear, bounds } from '../src/geometry';
import { booster, twin, empty } from '../src/examples';
const patch = (s: string, id: string, props: any) => applyChanges(s, patchFields(s,id,props));
test('initial scene: eight nodes, five connections, two taps', () => {
 const s = compile(booster).scene; assert.equal(s.nodes.length,8); assert.equal(s.links.length,5); assert.equal(s.nodes.filter(n=>n.tap).length,2);
 assert.equal(simulate(s).flows.get('P-101'),9.120000000000001);
});
test('ordinary TypeScript builders share vocabulary and ports', () => {
 const p = pump('P', {x:0,y:0,rpm:1000}), v = valve('V',{x:300,y:0,opening:80});
 assert.equal(connect(p.outlet,v.inlet).from.node,'P'); assert.equal(p.props.rpm,1000);
});
test('drag changes only numeric initializer spans, preserving comments', () => {
 const s = booster.replace('x: 325, y: 338', 'x: /* maintain */ 325, y: 338 /* mounting height */');
 const out = patch(s,'P-101',{x:365,y:400});
 assert.equal(out,s.replace('/* maintain */ 325','/* maintain */ 365').replace('y: 338 /* mounting','y: 400 /* mounting'));
});
test('negative coordinates and single quotes preserve source style', () => {
 const s = `import { pump } from '@scada/core';\nconst p = pump('P', {x: -100, y: 0, quality: 'good'});`;
 assert.match(patch(s,'P',{x:-240,quality:'bad'}),/x: -240, y: 0, quality: 'bad'/);
});
test('missing default fields are inserted without changing other bytes', () => {
 const s = `import { pump } from '@scada/core'; const p = pump('P', {/* position */ x: 1, y: 2});`;
 const out=patch(s,'P',{rpm:800}); assert.match(out,/rpm: 800/); assert.match(out,/\/\* position \*\/ x: 1, y: 2/);
 assert.equal(compile(out).scene.nodes[0].props.rpm,800);
});
test('computed coordinates are evaluated but never overwritten by drag', () => {
 const s = `import { pump } from '@scada/core'; const GRID = 10; const p = pump('P',{x: GRID * 32, y: (200 + 50), rpm: 1500});`;
 const c=compile(s); assert.equal(c.scene.nodes[0].props.x,320); assert.equal(editable(c,'P','x'),false);
 assert.throws(()=>patchFields(s,'P',{x:340}),/вычисляется/);
});
test('imports may be aliased',()=>{ const s=`import { pump as motor } from '@scada/core'; const p=motor('P',{x:10,y:20});`; assert.equal(compile(s).scene.nodes[0].kind,'pump'); assert.equal(compile(patch(s,'P',{x:40})).scene.nodes[0].props.x,40); });
for (const [name, fragment, expected] of [
 ['arbitrary script','window.alert(1);',/DSL|выполняются/],
 ['infinite loop','while(true) {}',/Поддерживаются/],
 ['fetch','fetch("https://example.test");',/импортирован/],
 ['external import','import {pump} from "other";',/Разрешён/],
 ['duplicate identifiers','const q=1; const q=2;',/Повторное имя/],
 ['unknown call','import {pump} from "@scada/core"; const p=evil();',/импортирован/],
 ['syntax','const =',/expected|ожидается|declaration/i],
 ['bad numeric','import {pump} from "@scada/core"; const p=pump("P",{x:1/0});',/значение/],
 ['prototype key','import {pump} from "@scada/core"; const p=pump("P",{__proto__:0});',/нет свойства/],
 ['wrong type','import {pump} from "@scada/core"; const p=pump("P",{rpm:"fast"});',/ожидает number/],
 ['wrong enum','import {pump} from "@scada/core"; const p=pump("P",{quality:"maybe"});',/good/],
 ['duplicate field','import {pump} from "@scada/core"; const p=pump("P",{x:2,x:3});',/Повторное свойство/],
 ['spread','import {pump} from "@scada/core"; const p=pump("P",{...window});',/явные свойства/],
 ['invalid id','import {pump} from "@scada/core"; const p=pump("<script>",{});',/ID:/],
] as const) test(`reject ${name} without execution`,()=>assert.throws(()=>compile(fragment),expected));
test('too large a document is rejected before parsing',()=>assert.throws(()=>compile(' '.repeat(120001)),/размер/));
test('unknown ports, reverse port roles, occupied ports, duplicate IDs rejected',()=>{
 assert.throws(()=>compile(booster.replace('motor.inlet','motor.missing')),/Неизвестный порт/);
 assert.throws(()=>compile(booster.replace('reservoir.outlet, motor.inlet','motor.inlet, reservoir.outlet')),/выхода ко входу/);
 assert.throws(()=>compile(booster+'connect(reservoir.outlet, motor.inlet);'),/уже занят/);
 assert.throws(()=>compile(booster.replace('"F-101"','"P-101"')),/Повторный ID/);
});
test('delete node removes incident connections and attached instruments',()=>{
 const c=compile(applyChanges(booster,removeObject(booster,'P-101')));
 assert(!c.scene.nodes.some(n=>n.id==='P-101'||n.id==='PT-101')); assert.equal(c.scene.links.length,3);
});
test('delete instrument preserves its process connection',()=>{
 const c=compile(applyChanges(booster,removeObject(booster,'PT-101'))); assert.equal(c.scene.links.length,5); assert.equal(c.scene.nodes.length,7);
});
test('delete edge removes its taps and leaves other equipment',()=>{
 const edge=compile(booster).scene.links[1]; const c=compile(applyChanges(booster,removeObject(booster,edge.id))); assert.equal(c.scene.links.length,4); assert.equal(c.scene.nodes.length,7);
});
test('palette and port clicks append valid declarations',()=>{
 let s=appendEquipment(empty,'tank',100,100); s=appendEquipment(s,'pump',400,100);
 const c=compile(s); s=appendConnection(s,{node:c.scene.nodes[0].id,port:'outlet'},{node:c.scene.nodes[1].id,port:'inlet'});
 assert.equal(compile(s).scene.links.length,1);
});
test('tap names previously unnamed connect expression, preserving its text',()=>{
 const edge=compile(booster).scene.links[0]; const s=appendTap(booster,edge.id,'pressure'); const c=compile(s); assert.equal(c.scene.nodes.length,9); assert.match(s,/const line1 = connect\(reservoir/);
});
test('formatter produces a valid scene',()=>assert.deepEqual(compile(formatSource(booster)).scene,compile(booster).scene));
test('closed valve stops the entire series flow while RPM stays explicit',()=>{
 const c=compile(patch(booster,'V-101',{opening:0})); const sim=simulate(c.scene);
 assert.equal(sim.flows.get('P-101'),0); assert.equal(c.scene.nodes.find(n=>n.id==='P-101')!.props.rpm,1500);
});
test('partial opening and reverse affect connected flow',()=>{
 let s=patch(booster,'V-101',{opening:50}); s=patch(s,'P-101',{rpm:-1500}); assert.equal(simulate(compile(s).scene).flows.get('F-101'),-6);
});
test('stop, dry tank, trip, and missing quality have distinct semantics',()=>{
 for (const [id,values] of [['P-101',{rpm:0}],['T-101',{level:0}],['P-101',{alarm:'trip'}]] as const) assert.equal(simulate(compile(patch(booster,id,values)).scene).flows.get('F-101'),0);
 for (const quality of ['bad','stale']) assert.equal(simulate(compile(patch(booster,'P-101',{quality})).scene).flows.get('F-101'),null);
});
test('independent circuits do not share state',()=>{
 const c=compile(patch(twin,'V-101',{opening:0})); const sim=simulate(c.scene); assert.equal(sim.flows.get('P-101'),0); assert.equal(sim.flows.get('P-102'),-4);
});
test('disconnected circuits do not invent flow',()=>{
 const c=compile(applyChanges(booster,removeObject(booster,'OUT'))); const sim=simulate(c.scene); assert.equal(sim.flows.get('P-101'),null); assert(sim.notes.length);
});
function validateGeometry(s:string, expectedWarnings: string[] = []){
 const c=compile(s).scene, geometry=layout(c); assert.deepEqual(geometry.warnings,expectedWarnings);
 for(const edge of c.links){
  const route=geometry.routes.get(edge.id)!; assert(route.valid);
  const from=worldPort(c.nodes.find(n=>n.id===edge.from.node)!,edge.from.port),to=worldPort(c.nodes.find(n=>n.id===edge.to.node)!,edge.to.port);
  assert.equal(route.points[0].x,from.x);assert.equal(route.points[0].y,from.y); assert.equal(route.points.at(-1)!.x,to.x);assert.equal(route.points.at(-1)!.y,to.y);
  const boxes=c.nodes.filter(n=>!catalog[n.kind].instrument&&![edge.from.node,edge.to.node].includes(n.id)).map(n=>bounds(n,10));
  for(let i=1;i<route.points.length;i++)assert(segmentClear(route.points[i-1],route.points[i],boxes),`collision ${edge.id}`);
 }
}
test('initial and twin routes join exact ports and avoid equipment',()=>{validateGeometry(booster);validateGeometry(twin)});
test('move multiple equipment positions: links are derived, not stale SVG',()=>{
 for(const [id,values] of [['P-101',{x:340,y:400}],['V-101',{x:830,y:100}],['F-101',{x:680,y:30}],['HX-101',{x:1080,y:380}],['T-101',{x:30,y:500}]] as const)validateGeometry(patch(booster,id,values), id === 'HX-101' ? ['Перекрытие: OUT / TT-101', 'TT-101: для отвода нужен горизонтальный участок от 90 единиц. Раздвиньте оборудование.'] : []);
});
test('obstruction is reported, never silently marked correct',()=>{
 const c=compile(patch(booster,'P-101',{x:40,y:250})); assert(layout(c.scene).warnings.some(w=>w.includes('Перекрытие')));
});

test('short tap section reports an explicit placement warning without detaching pipes',()=>{
 const c=compile(patch(booster,'HX-101',{x:1080,y:380})).scene; const g=layout(c); assert(g.warnings.some(w=>w.startsWith('TT-101:'))); assert([...g.routes.values()].every(r=>r.valid));
});
