import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { advancePhase, ComponentRegistry, readSignal, worldPort } from '../src/next/model';
import { registry, pump } from '../src/next/components';
import { createModel } from '../lab3d/models';
import { assets, fixture } from '../lab3d/fixtures';

test('A separately registered component supports custom fields and a third named port', () => {
  const custom = { ...pump, type: 'vendor.pump.v2', parameters: { ...pump.parameters, stages: { default: 2, min: 1, max: 8, unit: 'count' } }, ports: p => [...pump.ports(p), { id: 'DRAIN', position: [0, 0, 0], normal: [0, 0, -1], medium: 'water', role: 'out' }] } as typeof pump;
  const extensions = new ComponentRegistry().register(custom);
  assert.equal(extensions.create(custom.type, 'P-NEW', { stages: 4 }).parameters.stages, 4);
  assert.equal(extensions.get(custom.type).ports({ scale: 1 }).length, 3);
  assert.throws(() => extensions.register(custom), /Duplicate/);
  assert.throws(() => extensions.create(custom.type, 'X', { stages: 100 }), /Invalid/);
});
test('Metre ports agree with Three transforms under translation and arbitrary pump rotation', () => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.7, -.4, 1.1));
  const asset = { ...registry.create(pump.type, 'rotated', { scale: 1.4 }), pose3D: { position: [3, -4, 5] as const, rotation: q.toArray() as [number, number, number, number] } };
  const model = createModel(asset); model.root.updateMatrixWorld(true);
  for (const port of pump.ports(asset.parameters)) {
    const expected = worldPort(port, asset.pose3D);
    const anchor = model.anchors.get(port.id)!;
    assert.ok(anchor.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(expected.position)) < 1e-9);
    assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion())).distanceTo(new THREE.Vector3().fromArray(expected.normal)) < 1e-9);
  }
});
test('Invalid signal quality and units never become valid zero', () => {
  const signal = fixture('normal')['P-101'].signals;
  assert.equal(readSignal(signal, 'flow', 'm3/h'), 24);
  assert.equal(readSignal(signal, 'flow', 'L/s'), null);
  for (const quality of ['stale', 'bad', 'offline'] as const) assert.equal(readSignal(fixture(quality)['P-101'].signals, 'flow', 'm3/h'), null);
  assert.equal(readSignal(fixture('stopped')['P-101'].signals, 'flow', 'm3/h'), 0);
});
test('Motor motion and measured flow remain independent through zero and reverse flow', () => {
  const model = createModel(assets[1]);
  model.update(fixture('zero-flow')['P-101'].signals, 1);
  assert.ok(model.metrics().phase! > 0); assert.equal(model.metrics().flow, 0);
  const before = model.metrics().phase!;
  model.update(fixture('reverse')['P-101'].signals, .1);
  assert.ok(model.metrics().phase! > before); assert.equal(model.metrics().flow, -12);
  const stoppedAt = model.metrics().phase;
  model.update(fixture('stopped')['P-101'].signals, 2); assert.equal(model.metrics().phase, stoppedAt);
});
test('Animation phase is continuous, frame-partition independent, and freezes without good telemetry', () => {
  let phase = .95; for (let i = 0; i < 60; i++) phase = advancePhase(phase, .35, 1 / 60);
  assert.ok(Math.abs(phase - advancePhase(.95, .35, 1)) < 1e-12);
  assert.ok(Math.abs(advancePhase(.4, 0, 5) - .4) < 1e-12);
  assert.throws(() => advancePhase(0, 1, -1), /Invalid/);
  const model = createModel(assets[1]); model.update(fixture('normal')['P-101'].signals, 1);
  const before = model.metrics().phase; model.update(fixture('bad')['P-101'].signals, 1); assert.equal(model.metrics().phase, before);
});
test('Tank empty/full limits stay within the working height and unknown level is hidden', () => {
  const model = createModel(assets[0]);
  model.update(fixture('empty')['TK-101'].signals, 0); assert.equal(model.metrics().liquidTop, null);
  model.update(fixture('full')['TK-101'].signals, 0); assert.equal(model.metrics().liquidTop, .28 + assets[0].parameters.height);
  model.update(fixture('offline')['TK-101'].signals, 0); assert.equal(model.metrics().liquidTop, null);
  assert.throws(() => createModel({ ...assets[0], pose3D: { position: [0, 0, 0], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } }), /yaw only/);
});
test('Command does not overwrite valve feedback or determine flow split', () => {
  const state = fixture('mismatch')['V-101'], model = createModel(assets[2]); model.update(state.signals, 0);
  assert.equal(model.metrics().position, 65); assert.equal(state.signals.command.value, 10);
  assert.equal(state.signals.flowA.value! / state.signals.flowAB.value!, .6);
});
