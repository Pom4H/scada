import { el, registerSvgRenderer, register3dRenderer } from '../../view';
import type { BufferGeometry, Material } from 'three';

registerSvgRenderer('filter', context => {
  const { root, paint } = context;
  el(root, 'path', { d: 'M0 40H130V60H0Z', fill: paint('metal'), stroke: '#718e9c', 'stroke-width': 1.5 });
  el(root, 'path', { d: 'M34 24H96L87 78H43Z', fill: paint('metal'), stroke: '#618491', 'stroke-width': 2 });
  el(root, 'path', { d: 'M48 29L80 73M61 29L83 60M43 42L65 74M44 60L66 30M49 73L82 30M62 74L87 42', fill: 'none', stroke: '#5e8996', 'stroke-width': 1.4, 'data-part': 'filter-mesh' });
  const value = el(root, 'text', { x: 65, y: 98, fill: '#315668', 'font-size': 11, 'font-family': 'ui-monospace, monospace', 'text-anchor': 'middle', 'data-signal': 'differentialPressure' });
  context.onUpdate(dt => { const dp = context.number('differentialPressure', dt); value.textContent = dp === null ? 'ΔP — бар' : `ΔP ${dp.toFixed(2)} бар`; });
});

register3dRenderer('filter', context => {
  const { THREE, materials } = context, root = new THREE.Group();
  const add = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number) => { const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh; };
  add(new THREE.CylinderGeometry(.29, .23, .88, 32), materials.steel, 0, 0, .73).rotation.x = Math.PI / 2;
  const line = add(new THREE.CylinderGeometry(.10, .10, 1.3, 24), materials.teal, 0, 0, .73); line.rotation.z = Math.PI / 2;
  for (const x of [-.6, .6]) add(new THREE.CylinderGeometry(.18, .18, .07, 24), materials.steel, x, 0, .73).rotation.z = Math.PI / 2;
  add(new THREE.BoxGeometry(.64, .64, .10), materials.dark, 0, 0, .20);
  for (let i = 0; i < 7; i++) add(new THREE.TorusGeometry(.285 - i * .006, .012, 6, 24), materials.teal, 0, 0, .42 + i * .09);
  add(new THREE.CylinderGeometry(.32, .32, .07, 32), materials.dark, 0, 0, 1.20).rotation.x = Math.PI / 2;
  return { root, ports: new Map([['inlet', new THREE.Vector3(-.65, 0, .73)], ['outlet', new THREE.Vector3(.65, 0, .73)]]), labelAnchor: new THREE.Vector3(0, 0, 1.55), readout: 'differentialPressure', update: () => {}, metrics: () => ({ differentialPressure: context.number('differentialPressure') }) };
});
