import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, SourceError, applyChanges, patchFields, removeObject, appendEquipment, appendTap } from '../src/source';
import { simulate, worldPort, catalog } from '../src/core';
import { layout, bounds, segmentClear, tapPoint } from '../src/geometry';
import { booster, twin } from '../src/examples';
import { nestedTap, collidingImport, stackedTaps, crowdedCircuit } from './fixtures';

const patch = (s: string, id: string, fields: Record<string, string | number>) => applyChanges(s, patchFields(s, id, fields));

// These assertions specify the desired behavior. Known defects FAIL normally;
// no test is skipped, marked todo, or made green by asserting broken behavior.
test('C01 deleting a nested instrument preserves the process pipe', () => {
  const before = compile(nestedTap).scene;
  const after = compile(applyChanges(nestedTap, removeObject(nestedTap, 'PT'))).scene;
  assert.equal(after.nodes.length, before.nodes.length - 1);
  assert.deepEqual(after.links.map(l => l.id), before.links.map(l => l.id), 'Deleting PT must not delete its pipe');
});

test('C02 a nested connect can receive a second instrument', () => {
  const before = compile(nestedTap).scene;
  const after = compile(appendTap(nestedTap, before.links[0].id, 'temperature')).scene;
  assert.equal(after.links.length, 1);
  assert.equal(after.nodes.filter(n => n.tap === before.links[0].id).length, 2);
});

test('C03 palette insertion aliases imports that collide with scalar constants', () => {
  const result = appendEquipment(collidingImport, 'tank', 800, 100);
  const scene = compile(result).scene;
  assert.equal(scene.nodes.find(n => n.id === 'P')!.props.x, 20);
  assert.equal(scene.nodes.filter(n => n.kind === 'tank').length, 1);
  assert.ok(result.includes('const tank = 20;'));
});

test('C04 excessive nesting produces a bounded SourceError, not a parser stack overflow', () => {
  const source = 'const depth = ' + '('.repeat(3000) + '1' + ')'.repeat(3000) + ';';
  assert.ok(source.length < 120_000);
  assert.throws(() => compile(source), SourceError);
  assert.equal(compile(booster).scene.nodes.length, 8, 'Compiler must remain usable');
});

test('C05 unsupported topology reports unknown flow, distinct from measured zero', () => {
  const scene = compile(applyChanges(booster, removeObject(booster, 'OUT'))).scene;
  const result = simulate(scene);
  assert.ok(result.notes.length > 0);
  assert.equal(result.flows.get('F-101'), null, 'A circuit without a solution must not report 0 m³/h');
});

test('C06 overlapping attached instruments produce an explicit layout warning', () => {
  const scene = compile(stackedTaps).scene;
  const result = layout(scene);
  const [a, b] = scene.nodes.filter(n => n.tap);
  const pa = tapPoint(result.routes.get(a.tap!)!, Number(a.props.at));
  const pb = tapPoint(result.routes.get(b.tap!)!, Number(b.props.at));
  assert.deepEqual(pa, pb, 'Fixture places both instruments on the same tap');
  assert.ok(result.warnings.some(w => w.includes('PT') && w.includes('TT')), 'Both instrument IDs should appear in a collision warning');
});

test('C07 trip, dry tank and closed valve stop all connected flow immediately', () => {
  for (const [id, fields] of [['P-101', { alarm: 'trip' }], ['V-101', { alarm: 'trip' }], ['V-101', { opening: 0 }], ['T-101', { level: 0 }]] as const) {
    const scene = compile(patch(booster, id, fields)).scene;
    const result = simulate(scene);
    for (const link of scene.links) assert.equal(result.flows.get(link.id), 0);
  }
});

test('C08 bad or stale quality makes the whole connected flow unknown', () => {
  for (const quality of ['bad', 'stale']) for (const id of ['P-101', 'T-101', 'V-101', 'F-101']) {
    const scene = compile(patch(booster, id, { quality })).scene;
    for (const q of simulate(scene).flows.values()) assert.equal(q, null);
  }
});

test('C09 201 signed RPM transitions preserve direction on every pipe', () => {
  for (let i = -100; i <= 100; i++) {
    const scene = compile(patch(booster, 'P-101', { rpm: i * 30 })).scene;
    const result = simulate(scene);
    for (const link of scene.links) assert.ok(Math.abs(result.flows.get(link.id)! - 12 * i * 30 / 1500 * .76) < 1e-9);
  }
});

test('C10 independent circuits isolate trip and unavailable telemetry', () => {
  for (const fields of [{ alarm: 'trip' }, { quality: 'bad' }]) {
    const result = simulate(compile(patch(twin, 'P-101', fields)).scene);
    assert.equal(result.flows.get('P-102'), -4);
  }
});

test('C11 computed positions survive refused visual edits byte for byte', () => {
  const source = booster.replace('x: 325', 'x: (300 + 25)');
  assert.throws(() => patchFields(source, 'P-101', { x: 999 }), SourceError);
  assert.equal(compile(source).scene.nodes.find(n => n.id === 'P-101')!.props.x, 325);
});

test('C12 200 source edits preserve unrelated comments and remain recompilable', () => {
  const original = booster.replace('rpm: 1500', 'rpm: /* drive setpoint */ 1500 /* retain */');
  let source = original;
  for (let i = 0; i < 200; i++) source = patch(source, 'P-101', { rpm: (i % 121 - 60) * 50 });
  source = patch(source, 'P-101', { rpm: 1500 });
  assert.equal(source, original);
});

test('C13 48 elements route without collisions, and element 49 is rejected', () => {
  const scene = compile(crowdedCircuit(48)).scene;
  const result = layout(scene);
  assert.deepEqual(result.warnings, []);
  for (const link of scene.links) {
    const route = result.routes.get(link.id)!;
    assert.ok(route.valid);
    for (const [endpoint, point] of [[link.from, route.points[0]], [link.to, route.points.at(-1)!]] as const) {
      const port = worldPort(scene.nodes.find(n => n.id === endpoint.node)!, endpoint.port);
      assert.equal(point.x, port.x); assert.equal(point.y, port.y);
    }
    const boxes = scene.nodes.filter(n => !catalog[n.kind].instrument && n.id !== link.from.node && n.id !== link.to.node).map(n => bounds(n, 10));
    for (let i = 1; i < route.points.length; i++) assert.ok(segmentClear(route.points[i - 1], route.points[i], boxes));
  }
  assert.throws(() => compile(crowdedCircuit(49)), SourceError);
});

test('C14 arbitrary code and prototype access are rejected without execution', () => {
  for (const source of ['while (true) {}', 'globalThis.challengeSideEffect = true;', 'fetch("https://example.invalid");', 'import {pump} from "@scada/core"; const p=pump("P",{}); const x=p.constructor;']) assert.throws(() => compile(source), SourceError);
  assert.equal((globalThis as any).challengeSideEffect, undefined);
});
