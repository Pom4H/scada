import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { catalog, type Equipment, type Scene } from './core';
import { layout, tapPoint } from './geometry';
import { numeric, type RuntimeFrame } from './runtime/protocol';
import { get3dRenderer, observation, observationAlarm, observationQuality, observedFlows, type EquipmentModel3D, type Renderer3D, type Renderer3DContext } from './view';
import { createModel, materials, tubeBetween } from '../lab3d/models';
import { registry } from './next/components';
import type { Signals } from './next/model';

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const primarySignal: Record<string, string> = { tank: 'level', pump: 'rpm', valve: 'opening', pressure: 'value', temperature: 'value', exchanger: 'temperature' };
const unitLabel = (unit: string) => ({ 'm3/h': 'м³/ч', rpm: 'об/мин', 'mm/s': 'мм/с', bar: 'бар' })[unit] ?? unit;
const alarmLabel = { none: '', warning: 'Предупреждение', trip: 'Авария' };
function addMesh(root: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, position = v()) {
  const mesh = new THREE.Mesh(geometry, material); mesh.position.copy(position); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh;
}
function primitiveModel(context: Renderer3DContext, kind: string): EquipmentModel3D {
  const root = new THREE.Group(), definition = catalog[context.equipment.kind], width = Math.max(.55, definition.width / 110);
  const ports = new Map<string, THREE.Vector3>();
  for (const [key, spec] of Object.entries(definition.ports)) {
    const p = spec.direction === 'up' ? v(0, 0, 1.4) : spec.direction === 'down' ? v(0, 0, .1) : v(spec.direction === 'left' ? -width / 2 : width / 2, 0, .75);
    ports.set(key, p); tubeBetween(root, v(0, 0, .75), p, .11, materials.steel);
  }
  if (kind === 'valve') {
    addMesh(root, new THREE.SphereGeometry(.32, 24, 16), materials.teal, v(0, 0, .75));
    tubeBetween(root, v(0, 0, .8), v(0, 0, 1.3), .06, materials.steel);
    addMesh(root, new THREE.BoxGeometry(.5, .35, .22), materials.dark, v(0, 0, 1.3));
    const indicator = addMesh(root, new THREE.BoxGeometry(.34, .055, .045), materials.fluid, v(0, 0, 1.46));
    return { root, ports, labelAnchor: v(0, 0, 1.75), update: dt => { const opening = context.number('opening', dt); indicator.visible = opening !== null; indicator.rotation.z = (opening ?? 0) / 100 * Math.PI / 2; }, metrics: () => ({ opening: numeric(context.signal('opening')) }) };
  }
  if (kind === 'flowmeter' || kind === 'pressure' || kind === 'temperature') {
    addMesh(root, new THREE.CylinderGeometry(.32, .32, .18, 32), materials.steel, v(0, 0, .9));
    const glass = addMesh(root, new THREE.CircleGeometry(.26, 32), materials.dark, v(0, -.095, .9)); glass.rotation.x = Math.PI / 2;
    if (!ports.size) { tubeBetween(root, v(0, 0, .1), v(0, 0, .65), .04, materials.steel); }
    return { root, ports, labelAnchor: v(0, 0, 1.48), update: () => {} };
  }
  if (kind === 'outlet') {
    const arrow = addMesh(root, new THREE.ConeGeometry(.24, .48, 4), materials.teal, v(.18, 0, .75)); arrow.rotation.z = -Math.PI / 2;
    return { root, ports, labelAnchor: v(0, 0, 1.35), update: () => {} };
  }
  addMesh(root, new THREE.BoxGeometry(width * .76, .54, .96), materials.steel, v(0, 0, .72));
  addMesh(root, new THREE.BoxGeometry(width * .86, .68, .12), materials.dark, v(0, 0, .15));
  if (kind === 'exchanger') {
    for (let i = 0; i < 9; i++) addMesh(root, new THREE.BoxGeometry(.04, .6, 1.02), i % 2 ? materials.steel : materials.teal, v((i - 4) * width * .075, 0, .74));
  } else root.userData.representation = 'generic';
  return { root, ports, labelAnchor: v(0, 0, 1.55), update: () => {} };
}
function procedural(type: string, portNames: Record<string, string>): Renderer3D {
  return context => {
    const asset = registry.create(type, context.equipment.id), model = createModel(asset);
    const ports = new Map<string, THREE.Vector3>(), portNormals = new Map<string, THREE.Vector3>();
    for (const [name, anchor] of model.anchors) { ports.set(portNames[name] ?? name, anchor.position.clone()); portNormals.set(portNames[name] ?? name, v(0, 0, 1).applyQuaternion(anchor.quaternion)); }
    return {
      root: model.root, ports, portNormals, labelAnchor: v(0, 0, type === 'process.tank.vertical' ? 2.95 : 1.8), metrics: model.metrics, reset: model.reset, dispose: model.dispose,
      update: dt => {
        const signals: Record<string, Signals[string]> = {};
        for (const [key, spec] of Object.entries(registry.get(type).signals)) {
          const sample = context.signal(key), value = context.number(key, dt);
          signals[key] = { value, unit: spec.unit, timestamp: sample?.timestamp ?? 0, quality: sample?.quality ?? (context.mode() === 'preview' && value !== null ? 'good' : 'offline') };
        }
        // Alarm indication is immediate. The measured drive and measured flow stay independent.
        if (context.mode() === 'preview' && context.alarm() === 'trip' && signals.rpm) signals.rpm = { ...signals.rpm, value: 0 };
        model.update(signals, dt);
      },
    };
  };
}
const builtins = new Map<string, Renderer3D>([
  ['tank', procedural('process.tank.vertical', { OUT: 'outlet' })],
  ['pump', procedural('process.pump.centrifugal', { IN: 'inlet', OUT: 'outlet' })],
  ...['valve', 'flowmeter', 'pressure', 'temperature', 'exchanger', 'outlet'].map(kind => [kind, (context: Renderer3DContext) => primitiveModel(context, kind)] as const),
]);
interface Rendered { equipment: Equipment; model: EquipmentModel3D; label: HTMLButtonElement; text: HTMLElement; state: HTMLElement; leader: SVGLineElement }
interface FlowTrack { id: string; curve: THREE.CurvePath<THREE.Vector3>; particles: THREE.Mesh[]; body: THREE.Mesh[]; phase: number; value: number | null }

/** A schematic spatial view. Positions are derived from the drawing, not claimed as surveyed plant coordinates. */
export class SceneView3D {
  scene: Scene = { nodes: [], links: [] };
  paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  selected: string | null = null;
  onSelect?: (id: string | null) => void;
  private frame: RuntimeFrame | null = null;
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private equipmentLayer = new THREE.Group();
  private pipeLayer = new THREE.Group();
  private camera = new THREE.PerspectiveCamera(38, 1, .1, 300);
  private controls: OrbitControls;
  private canvas: HTMLCanvasElement;
  private labels: HTMLDivElement;
  private leaders: SVGSVGElement;
  private alert: HTMLDivElement;
  private objects = new Map<string, Rendered>();
  private tracks: FlowTrack[] = [];
  private smoothed = new Map<string, number>();
  private phases = new Map<string, number>();
  private flows = new Map<string, number | null>();
  private geometryKey = '';
  private resizeObserver: ResizeObserver;
  private raf = 0;
  private last = 0;
  private motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  constructor(public host: HTMLElement) {
    host.classList.add('scene3d');
    this.canvas = document.createElement('canvas'); this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D схема. Стрелки меняют ракурс, плюс и минус — масштаб, F — вписать. Оборудование можно выбрать клавишей Tab.');
    this.labels = document.createElement('div'); this.labels.className = 'scene3d-labels';
    this.leaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.leaders.classList.add('scene3d-leaders'); this.leaders.setAttribute('aria-hidden', 'true'); this.labels.appendChild(this.leaders);
    this.alert = document.createElement('div'); this.alert.className = 'scene3d-alert'; this.alert.setAttribute('role', 'status'); this.alert.hidden = true;
    const note = document.createElement('div'); note.className = 'scene3d-note'; note.textContent = 'Пространственная схема · размещение из 2D';
    host.replaceChildren(this.canvas, this.labels, this.alert, note);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0xf0f5f6); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.world.add(new THREE.HemisphereLight(0xe8f7ff, 0x8c9497, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.5); key.position.set(-4, -7, 12); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: .5, far: 45 }); key.shadow.bias = -.0003; this.world.add(key);
    const floor = addMesh(this.world, new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0xe6edef, roughness: .9 }), v(0, 0, -.025)); floor.castShadow = false;
    const grid = new THREE.GridHelper(100, 100, 0xc4d3d9, 0xd8e2e6); grid.rotation.x = Math.PI / 2; grid.position.z = -.015; this.world.add(grid);
    this.world.add(this.pipeLayer, this.equipmentLayer); this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.canvas); this.controls.enableDamping = false; this.controls.minDistance = 2; this.controls.maxDistance = 100; this.controls.maxPolarAngle = Math.PI / 2 - .015;
    this.controls.addEventListener('change', () => this.draw());
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.canvas.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        const offset = this.camera.position.clone().sub(this.controls.target), spherical = new THREE.Spherical().setFromVector3(v(offset.x, offset.z, -offset.y));
        if (event.key === 'ArrowLeft') spherical.theta -= .13; if (event.key === 'ArrowRight') spherical.theta += .13;
        if (event.key === 'ArrowUp') spherical.phi = Math.max(.12, spherical.phi - .10); if (event.key === 'ArrowDown') spherical.phi = Math.min(Math.PI / 2 - .03, spherical.phi + .10);
        const next = new THREE.Vector3().setFromSpherical(spherical); this.camera.position.copy(this.controls.target).add(v(next.x, -next.z, next.y)); this.controls.update(); event.preventDefault(); event.stopPropagation();
      }
      if (event.key === '+' || event.key === '=') { this.zoom(.8); event.preventDefault(); }
      if (event.key === '-') { this.zoom(1.25); event.preventDefault(); }
      if (event.key.toLowerCase() === 'f') { this.fit(); event.preventDefault(); event.stopPropagation(); }
      if (event.key === 'Escape') { this.select(null); this.onSelect?.(null); }
    });
    this.canvas.addEventListener('pointerdown', e => { this.down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', e => {
      if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return;
      const rect = this.canvas.getBoundingClientRect(), drawingHeight = rect.height - (rect.width <= 650 ? 77 : 0);
      if (e.clientY - rect.top > drawingHeight) return;
      this.raycaster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / drawingHeight * 2 + 1), this.camera);
      let object: THREE.Object3D | undefined = this.raycaster.intersectObjects(this.equipmentLayer.children, true)[0]?.object;
      while (object && !object.userData.equipmentId) object = object.parent ?? undefined;
      const id = object?.userData.equipmentId ?? null; this.select(id); this.onSelect?.(id);
    });
    const animate = (now: number) => {
      const dt = Math.min(.1, this.last ? (now - this.last) / 1000 : 0); this.last = now;
      if (host.clientWidth && host.clientHeight && !host.hidden) { this.advance(this.paused || this.motionQuery.matches ? 0 : dt); this.draw(); }
      this.raf = requestAnimationFrame(animate);
    };
    this.resize(); this.raf = requestAnimationFrame(animate);
  }
  private context(equipment: Equipment): Renderer3DContext {
    return { THREE, equipment, materials,
      signal: key => observation(this.scene, this.frame, equipment.id, key), quality: key => observationQuality(this.scene, this.frame, equipment.id, key),
      alarm: () => observationAlarm(this.scene, this.frame, equipment.id), mode: () => this.frame?.equipment[equipment.id]?.facts.mode ?? 'preview',
      number: (key, dt = 0) => {
        const target = key === 'flow' ? this.flows.get(equipment.id) ?? null : numeric(observation(this.scene, this.frame, equipment.id, key));
        if (target === null) return null;
        const cacheKey = `${equipment.id}:${key}`, old = this.smoothed.get(cacheKey) ?? target;
        const value = this.paused || this.motionQuery.matches || Math.abs(target - old) < .03 ? target : old + (target - old) * (1 - Math.exp(-dt * 10));
        this.smoothed.set(cacheKey, value); return value;
      },
      phase: (part, speed, dt) => { const key = `${equipment.id}:${part}`, phase = ((this.phases.get(key) ?? 0) + (this.paused || this.motionQuery.matches ? 0 : speed * dt)) % 1; this.phases.set(key, phase); return phase; },
    };
  }
  render(scene: Scene) {
    this.scene = scene; this.flows = observedFlows(scene, this.frame);
    const geometryKey = JSON.stringify([scene.nodes.map(n => [n.id, n.kind, n.props.x, n.props.y, n.tap, n.props.at, n.props.offset]), scene.links]);
    if (geometryKey === this.geometryKey) { for (const n of scene.nodes) this.objects.get(n.id)!.equipment.props = { ...n.props }; this.advance(0); this.draw(); return; }
    this.geometryKey = geometryKey;
    const previous = this.objects, hadModels = previous.size > 0, trackPhases = new Map(this.tracks.map(track => [track.id, track.phase]));
    this.objects = new Map(); this.equipmentLayer.clear(); this.leaders.replaceChildren(); this.labels.replaceChildren(this.leaders);
    this.pipeLayer.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); this.pipeLayer.clear(); this.tracks = [];
    const routes = layout(scene).routes;
    for (const original of scene.nodes) {
      let object = previous.get(original.id);
      if (object?.equipment.kind !== original.kind) object = undefined;
      if (object) previous.delete(original.id);
      const equipment = object?.equipment ?? { ...original, props: { ...original.props } }, definition = catalog[equipment.kind];
      equipment.props = { ...original.props }; equipment.tap = original.tap;
      const context = this.context(equipment), model = object?.model ?? (get3dRenderer(equipment.kind) ?? builtins.get(equipment.kind) ?? (ctx => primitiveModel(ctx, 'generic')))(context);
      let x = Number(equipment.props.x) / 100, y = -Number(equipment.props.y) / 100;
      if (equipment.tap) { const route = routes.get(equipment.tap); if (route) { const point = tapPoint(route, Number(equipment.props.at)); x = point.x / 100; y = -(point.y - Number(equipment.props.offset)) / 100; } }
      model.root.position.set(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, 0); model.root.userData.equipmentId = equipment.id;
      this.equipmentLayer.add(model.root);
      const label = object?.label ?? document.createElement('button'); label.className = 'scene3d-label'; label.dataset.node3d = equipment.id; label.dataset.kind = equipment.kind;
      label.setAttribute('aria-label', `${equipment.id} ${definition.label}`); label.onclick = () => { this.select(equipment.id); this.onSelect?.(equipment.id); };
      const title = document.createElement('strong'); title.textContent = equipment.id;
      const text = object?.text ?? document.createElement('span'), state = object?.state ?? document.createElement('small'); label.replaceChildren(title, text, state); this.labels.appendChild(label);
      const leader = object?.leader ?? document.createElementNS('http://www.w3.org/2000/svg', 'line'); this.leaders.appendChild(leader);
      this.objects.set(equipment.id, { equipment, model, label, text, state, leader });
    }
    for (const { model } of previous.values()) { model.dispose?.(); model.root.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); }
    for (const edge of scene.links) {
      const a = this.objects.get(edge.from.node), b = this.objects.get(edge.to.node);
      const start = a?.model.ports.get(edge.from.port)?.clone().add(a.model.root.position), end = b?.model.ports.get(edge.to.port)?.clone().add(b.model.root.position);
      if (!start || !end) continue;
      const normal = (object: Rendered, port: string) => object.model.portNormals?.get(port)?.clone() ?? ({ left: v(-1, 0, 0), right: v(1, 0, 0), up: v(0, 0, 1), down: v(0, 0, -1) })[catalog[object.equipment.kind].ports[port].direction];
      const startLead = start.clone().addScaledVector(normal(a!, edge.from.port), .30), endLead = end.clone().addScaledVector(normal(b!, edge.to.port), .30);
      const curve = new THREE.CurvePath<THREE.Vector3>(), high = Math.max(startLead.z, endLead.z), middleX = (startLead.x + endLead.x) / 2;
      const points = [start, startLead, v(startLead.x, startLead.y, high), v(middleX, startLead.y, high), v(middleX, endLead.y, high), v(endLead.x, endLead.y, high), endLead, end], body: THREE.Mesh[] = [];
      for (let i = 1; i < points.length; i++) if (points[i].distanceTo(points[i - 1]) > .001) { curve.add(new THREE.LineCurve3(points[i - 1], points[i])); body.push(tubeBetween(this.pipeLayer, points[i - 1], points[i], .085, materials.fluid)); }
      if (!curve.curves.length) continue;
      const particles = [0, 1, 2, 3].map(() => addMesh(this.pipeLayer, new THREE.ConeGeometry(.14, .28, 8), materials.dark));
      this.tracks.push({ id: edge.id, curve, particles, body, phase: trackPhases.get(edge.id) ?? 0, value: null });
    }
    for (const { equipment, model } of this.objects.values()) {
      if (!equipment.tap) continue;
      const track = this.tracks.find(track => track.id === equipment.tap); if (!track) continue;
      const point = track.curve.getPointAt(Math.max(0, Math.min(1, Number(equipment.props.at)))), stem = model.root.position.clone().add(v(0, 0, .1));
      tubeBetween(this.pipeLayer, point, v(stem.x, stem.y, point.z), .025, materials.steel);
      tubeBetween(this.pipeLayer, v(stem.x, stem.y, point.z), stem, .025, materials.steel);
    }
    this.advance(0); this.select(this.selected); if (!hadModels) this.fit(); else this.draw();
  }
  setRuntime(frame: RuntimeFrame | null) {
    if (frame?.runId !== this.frame?.runId) { this.smoothed.clear(); this.phases.clear(); for (const track of this.tracks) track.phase = 0; for (const { model } of this.objects.values()) model.reset?.(); }
    this.frame = frame; this.flows = observedFlows(this.scene, frame);
    this.host.dataset.runId = frame?.runId ?? ''; this.host.dataset.sequence = String(frame?.seq ?? '');
    this.advance(0); this.draw();
  }
  private advance(dt: number) {
    const alerts: string[] = [];
    for (const { equipment, model, label, text, state } of this.objects.values()) {
      model.update(dt);
      const quality = observationQuality(this.scene, this.frame, equipment.id), alarm = observationAlarm(this.scene, this.frame, equipment.id);
      const key = model.readout ?? primarySignal[equipment.kind] ?? Object.keys(catalog[equipment.kind].signals ?? {})[0] ?? 'flow';
      const sample = observation(this.scene, this.frame, equipment.id, key), value = key === 'flow' ? this.flows.get(equipment.id) ?? null : numeric(sample);
      text.textContent = value === null ? '—' : `${value.toFixed(key === 'rpm' || key === 'level' ? 0 : 1)} ${unitLabel(sample?.unit ?? (key === 'flow' ? 'm3/h' : ''))}`;
      state.textContent = [alarmLabel[alarm], quality !== 'good' ? 'Нет данных' : ''].filter(Boolean).join(' · ');
      label.dataset.quality = quality; label.dataset.alarm = alarm; label.dataset.instanceId = this.frame?.equipment[equipment.id]?.instanceId ?? '';
      if (alarm !== 'none') alerts.push(`${equipment.id} · ${alarmLabel[alarm]}`);
      else if (quality !== 'good') alerts.push(`${equipment.id} · Нет данных`);
    }
    this.alert.textContent = alerts.join('   ·   '); this.alert.hidden = !alerts.length;
    for (const track of this.tracks) {
      track.value = this.flows.get(track.id) ?? null;
      track.phase = ((track.phase + (track.value ?? 0) / 24 * .2 * dt) % 1 + 1) % 1;
      track.body.forEach(mesh => { mesh.material = track.value === null ? materials.greyFluid : materials.fluid; });
      track.particles.forEach((arrow, i) => {
        arrow.visible = track.value !== null && track.value !== 0;
        const position = (track.phase + i / 4) % 1; arrow.position.copy(track.curve.getPointAt(position));
        arrow.quaternion.setFromUnitVectors(v(0, 1, 0), track.curve.getTangentAt(position).normalize().multiplyScalar((track.value ?? 0) < 0 ? -1 : 1));
      });
    }
  }
  select(id: string | null) { this.selected = id; for (const object of this.objects.values()) { object.label.classList.toggle('selected', object.equipment.id === id); object.label.setAttribute('aria-pressed', String(object.equipment.id === id)); } this.draw(); }
  setSelected(id: string | null) { this.select(id); }
  fit() {
    const bounds = new THREE.Box3().setFromObject(this.equipmentLayer); if (bounds.isEmpty()) bounds.set(v(-2, -2, 0), v(2, 2, 2));
    const center = bounds.getCenter(v()), direction = v(-.45, -1, .73).normalize(), right = v(0, 0, 1).cross(direction).normalize(), up = direction.clone().cross(right).normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2), tanH = tanV * this.camera.aspect;
    let distance = 3;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = v(x, y, z).sub(center), depth = corner.dot(direction);
      distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanH, depth + Math.abs(corner.dot(up)) / tanV);
    }
    this.controls.target.copy(center); this.camera.position.copy(center).add(direction.multiplyScalar(distance * 1.18)); this.controls.update(); this.draw();
  }
  zoom(factor: number) { const offset = this.camera.position.clone().sub(this.controls.target); this.camera.position.copy(this.controls.target).add(offset.multiplyScalar(factor)); this.controls.update(); this.draw(); }
  private resize() { const width = this.host.clientWidth, height = this.host.clientHeight; if (!width || !height) return; const bottom = width <= 650 ? 77 : 0, drawingHeight = Math.max(1, height - bottom); this.renderer.setSize(width, height, false); this.renderer.setViewport(0, bottom, width, drawingHeight); this.camera.aspect = width / drawingHeight; this.camera.updateProjectionMatrix(); this.draw(); }
  private draw() {
    if (!this.host.clientWidth || !this.host.clientHeight || this.host.hidden) return;
    this.renderer.render(this.world, this.camera);
    const width = this.host.clientWidth, height = this.host.clientHeight, compact = width <= 650;
    const placed: { x: number; y: number; width: number; height: number }[] = [];
    const labels = [...this.objects.values()].map(object => {
      const { model, label } = object;
      const point = (model.labelAnchor?.clone() ?? v(0, 0, 1.6)).applyMatrix4(model.root.matrixWorld).project(this.camera);
      return { ...object, point, px: (point.x + 1) * width / 2, py: (1 - point.y) * height / 2, width: label.offsetWidth || 90, height: label.offsetHeight || 45 };
    }).sort((a, b) => a.py - b.py);
    for (const item of labels) {
      const { label, leader, point, px, py } = item;
      label.hidden = !compact && (point.z < -1 || point.z > 1);
      if (compact || label.hidden) { leader.style.display = 'none'; continue; }
      const x = Math.max(8, Math.min(width - item.width - 8, px - item.width / 2));
      const minimum = this.alert.hidden ? 10 : 56, maximum = Math.max(minimum, height - item.height - 24);
      const desired = Math.max(minimum, Math.min(maximum, py - item.height));
      const candidates = [desired, ...placed.flatMap(r => [r.y - item.height - 6, r.y + r.height + 6])].filter(y => y >= minimum && y <= maximum).sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
      const y = candidates.find(y => !placed.some(r => x < r.x + r.width + 5 && x + item.width + 5 > r.x && y < r.y + r.height + 5 && y + item.height + 5 > r.y)) ?? desired;
      placed.push({ x, y, width: item.width, height: item.height });
      label.style.left = `${x + item.width / 2}px`; label.style.top = `${y + item.height}px`;
      const moved = Math.abs(y - desired) > 5 || Math.abs(x + item.width / 2 - px) > 5;
      leader.style.display = moved ? '' : 'none';
      if (moved) { leader.setAttribute('x1', String(px)); leader.setAttribute('y1', String(py)); leader.setAttribute('x2', String(x + item.width / 2)); leader.setAttribute('y2', String(y + item.height)); }
    }
  }
  inspect() { return { runId: this.frame?.runId ?? null, seq: this.frame?.seq ?? null, triangles: this.renderer.info.render.triangles, calls: this.renderer.info.render.calls, equipment: [...this.objects.values()].map(({ equipment, model }) => ({ id: equipment.id, instanceId: this.frame?.equipment[equipment.id]?.instanceId ?? null, signals: this.frame?.equipment[equipment.id]?.signals ?? null, alarm: observationAlarm(this.scene, this.frame, equipment.id), metrics: model.metrics?.() ?? {}, ports: Object.fromEntries([...model.ports].map(([key, point]) => [key, point.clone().add(model.root.position).toArray()])) })), flows: this.tracks.map(({ id, phase, value }) => ({ id, phase, value })) }; }
  private clearGeometry() {
    for (const { model } of this.objects.values()) model.dispose?.();
    for (const layer of [this.equipmentLayer, this.pipeLayer]) { layer.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); layer.clear(); }
    this.objects.clear(); this.tracks = []; this.leaders.replaceChildren(); this.labels.replaceChildren(this.leaders);
  }
  dispose() { cancelAnimationFrame(this.raf); this.resizeObserver.disconnect(); this.controls.dispose(); this.clearGeometry(); this.world.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); }); this.renderer.dispose(); this.host.replaceChildren(); }
}
