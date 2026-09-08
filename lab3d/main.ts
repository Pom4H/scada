import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { registry } from '../src/next/components';
import { advancePhase, readSignal, worldPort, type Vec3 } from '../src/next/model';
import { assets, fixture, scenarios, type Scenario } from './fixtures';
import { createModel, materials, tubeBetween } from './models';
import index from '../catalog/drawio-pid-index.json';
import './style.css';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const symbolRenderers = new Map<string, () => string>([
  ['process.tank.vertical', () => '<rect x="-26" y="-26" width="52" height="52" rx="7"/><rect id="tank-fill-2d" x="-24" y="0" width="48" height="24" stroke="none" fill="#75cdd0"/><path id="tank-level-2d" d="M-24 0 H24"/>'],
  ['process.pump.centrifugal', () => '<circle r="24"/><path d="M-10 -13 L17 0 L-10 13 Z"/>'],
  ['process.valve.three-way.diverting', () => '<path d="M-27 -17 L27 17 V-17 L-27 17 Z M0 0 L-16 30 H16 Z"/>'],
]);
$('#app').innerHTML = `<header><a class="brand" href="#">s<span>c</span>ada<span class="brand-dot">.</span></a><div class="header-title">Equipment lab <span>/ 3D foundation</span></div><span class="fixture-badge">FIXTURE · NO LIVE DATA</span></header>
<main><nav class="rail" aria-label="Equipment"><div class="eyebrow">PROCESS / 01</div><h1>Water transfer</h1><p class="muted">One asset model.<br>Two ways to see it.</p><div class="asset-nav"><button data-asset="all" aria-pressed="true"><span>◈</span> Overview <small>03</small></button>${assets.map((a,i) => `<button data-asset="${a.id}" aria-pressed="false"><span>${['▥','◉','⋈'][i]}</span><div>${a.id}<small>${registry.get(a.type).label}</small></div></button>`).join('')}</div><div class="rail-note"><span class="eyebrow">MODEL LIBRARY</span><strong>3 procedural models</strong><p>478 indexed symbols<br>24 source categories</p><a href="#catalog">Explore catalog ↗</a></div></nav>
<section class="workspace"><div class="scene-header"><div><span class="eyebrow">SPATIAL VIEW</span><h2 id="scene-title">Process overview</h2></div><div class="view-buttons" aria-label="Camera"><button data-view="iso" aria-pressed="true">Iso</button><button data-view="front">Front</button><button data-view="side">Side</button><button data-view="top">Top</button></div></div><div id="viewport"><canvas aria-label="Interactive 3D process equipment; use the equipment list and camera buttons for keyboard navigation"></canvas><div class="viewport-note">Conditional cutaway · metres · Z up</div><div id="port-labels"></div><div class="orbit-hint">Drag to orbit · Scroll to zoom</div></div><div class="playback"><button id="play" aria-pressed="false">▶ Play</button><label for="timeline">Frame time</label><input id="timeline" type="range" min="0" max="8" step="0.0166666667" value="0"><output id="clock">0.00 s</output><span>Symbolic motion</span></div><section class="schematic"><div class="schematic-title"><span class="eyebrow">PROCESS VIEW</span><span>Shared tags & signals · independent layout</span></div><svg viewBox="0 0 900 135" role="img" aria-label="2D process schematic using the same asset identities"><path class="connection" d="M136 65 H386 M434 65 H673 M727 65 H850 M700 95 V115 H850"/>${assets.map(a => `<g transform="translate(${a.layout2D.x} ${a.layout2D.y})" class="symbol">${symbolRenderers.get(a.type)!()}<text y="-39">${a.id}</text><text y="53" id="svg-${a.id}"></text></g>`).join('')}<text x="857" y="70">A</text><text x="857" y="120">B</text></svg></section></section>
<aside class="inspector"><div class="eyebrow">STATE EXPLORER</div><label for="scenario">Test scenario</label><select id="scenario">${scenarios.map(s => `<option value="${s}">${s.replace('-', ' ').toUpperCase()}</option>`).join('')}</select><div id="alarm" role="status"></div><div id="telemetry"></div><div class="signal-note">Flow is measured separately from motor speed and valve travel.</div><div class="sample-time">Sample · 2026-09-08 00:00:00 UTC</div></aside></main>
<section id="catalog"><div><span class="eyebrow">SOURCE CATALOG</span><h2>478 symbols to build from</h2><p>Searchable names from draw.io P&amp;ID. Indexed entries are references; the three models above are implemented.</p></div><label for="search">Find an element</label><input id="search" type="search" placeholder="Pump, valve, mixer, vessel…"><div id="catalog-results"></div><p class="catalog-credit">Source: <a href="https://github.com/jgraph/drawio/tree/dev/src/main/webapp/stencils/pid">draw.io / P&amp;ID</a> · Apache-2.0 repository · names only, no imported geometry</p></section>`;

const canvas = $('canvas') as HTMLCanvasElement;
const viewportAlert = document.createElement('div'); viewportAlert.id = 'viewport-alert'; viewportAlert.setAttribute('role', 'status'); $('#viewport').append(viewportAlert);
const schematic = $('.schematic svg');
const schematicScroll = document.createElement('div'); schematicScroll.className = 'schematic-scroll'; schematic.parentNode!.insertBefore(schematicScroll, schematic); schematicScroll.append(schematic);
schematic.insertAdjacentHTML('afterbegin', '<defs><pattern id="unknown-fill" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#fff4d8"/><path d="M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6" stroke="#b29653" stroke-width="2"/></pattern></defs>');
$<HTMLElement>('#svg-V-101').setAttribute('x', '-55');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.setClearColor(0xeef3f4);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, .1, 100); camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.maxPolarAngle = Math.PI / 2.05; controls.minDistance = 2; controls.maxDistance = 25;
scene.add(new THREE.HemisphereLight(0xf5fdff, 0x91a4ac, 2.3));
const light = new THREE.DirectionalLight(0xfff9ed, 4); light.position.set(-3, -6, 10); light.castShadow = true;
light.shadow.mapSize.set(2048, 2048); Object.assign(light.shadow.camera, { left: -9, right: 9, top: 7, bottom: -7 }); light.shadow.bias = -.0005; scene.add(light);
const fill = new THREE.DirectionalLight(0xb5e6ff, 2); fill.position.set(4, 5, 5); scene.add(fill);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0xe6edef, roughness: .95 })); floor.position.z = -.01; floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(24, 24, 0xc8d5db, 0xdce5e8); grid.rotation.x = Math.PI / 2; grid.position.z = .002; scene.add(grid);
const models = assets.map(a => createModel(a)); models.forEach(m => scene.add(m.root));
scene.updateMatrixWorld(true);
function portPosition(i: number, id: string) { return models[i].anchors.get(id)!.getWorldPosition(new THREE.Vector3()); }
const pipes = new THREE.Group(); scene.add(pipes);
const p0 = portPosition(0, 'OUT'), p1 = portPosition(1, 'IN'), p2 = portPosition(1, 'OUT'), p3 = portPosition(2, 'AB'), pa = portPosition(2, 'A'), pb = portPosition(2, 'B');
const routes = [
  { points: [p0, new THREE.Vector3(-1.5, 0, p0.z), new THREE.Vector3(-1.5, 0, p1.z), p1], asset: 'P-101', signal: 'flow' },
  { points: [p2, new THREE.Vector3(p2.x, 0, 1.8), new THREE.Vector3(1.6, 0, 1.8), new THREE.Vector3(1.6, 0, p3.z), p3], asset: 'V-101', signal: 'flowAB' },
  { points: [pa, new THREE.Vector3(4.7, 0, pa.z)], asset: 'V-101', signal: 'flowA' },
  { points: [pb, new THREE.Vector3(3, -1.55, pb.z), new THREE.Vector3(4.7, -1.55, pb.z)], asset: 'V-101', signal: 'flowB' },
];
const tracks = routes.map(route => {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 1; i < route.points.length; i++) {
    tubeBetween(pipes, route.points[i - 1], route.points[i], .09);
    path.add(new THREE.LineCurve3(route.points[i - 1], route.points[i]));
  }
  for (const point of route.points.slice(1, -1)) { const joint = new THREE.Mesh(new THREE.SphereGeometry(.091, 16, 12), materials.steel); joint.position.copy(point); pipes.add(joint); }
  const arrows = Array.from({ length: 3 }, () => { const arrow = new THREE.Mesh(new THREE.ConeGeometry(.145, .25, 16), materials.fluid); pipes.add(arrow); return arrow; });
  return { ...route, path, arrows, phase: 0, flow: null as number | null };
});
let snapshot = fixture('normal'), scenario: Scenario = 'normal', selection = 'all', time = 0, playing = false;
type View = 'iso' | 'front' | 'side' | 'top';
let currentView: View = 'iso';
function setView(view: View) {
  currentView = view;
  const asset = assets.find(a => a.id === selection), target = asset ? new THREE.Vector3().fromArray(asset.pose3D.position).add(new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(.2, .1, 1);
  const distance = (asset ? 5.5 : 14) * (canvas.clientWidth < 550 ? 1.35 : 1);
  const direction = ({ iso: [-.5, -1, .7], front: [0, -1, .05], side: [-1, 0, .15], top: [0, -.001, 1] } as const)[view];
  camera.position.copy(target).add(new THREE.Vector3().fromArray(direction).normalize().multiplyScalar(distance));
  controls.target.copy(target); controls.update();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  render();
}
function setSelection(id: string) {
  selection = id; models.forEach((m, i) => { m.root.visible = id === 'all' || assets[i].id === id; }); pipes.visible = id === 'all';
  document.querySelectorAll<HTMLButtonElement>('[data-asset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.asset === id)));
  $('#scene-title').textContent = id === 'all' ? 'Process overview' : registry.get(assets.find(a => a.id === id)!.type).label;
  setView(currentView);
}
function formatted(asset: string, key: string) {
  const signal = snapshot[asset].signals[key];
  if (signal.quality !== 'good' || signal.value === null) return 'UNKNOWN';
  return `${Number(signal.value.toFixed(1))} ${signal.unit === 'm3/h' ? 'm³/h' : signal.unit}`;
}
function updateText() {
  const alarm = scenario === 'trip' ? 'TRIP · P-101' : scenario === 'mismatch' ? 'COMMAND MISMATCH · V-101' : ['stale', 'bad', 'offline'].includes(scenario) ? `${scenario.toUpperCase()} · SIGNALS UNAVAILABLE` : 'No active alarms';
  $('#alarm').textContent = alarm; $('#alarm').className = scenario === 'trip' ? 'trip' : ['stale', 'bad', 'offline', 'mismatch'].includes(scenario) ? 'warning' : 'healthy';
  viewportAlert.textContent = alarm; viewportAlert.className = $('#alarm').className; viewportAlert.hidden = $('#alarm').className === 'healthy';
  $('#telemetry').innerHTML = assets.map(a => {
    const definition = registry.get(a.type), sample = snapshot[a.id];
    return `<section class="telemetry-card"><div class="card-heading"><strong>${a.id}</strong><span>${sample.alarm === 'trip' ? 'TRIP' : Object.values(sample.signals)[0].quality.toUpperCase()}</span></div><div class="equipment-name">${definition.label}</div>${Object.entries(definition.signals).map(([key]) => `<div class="signal"><span>${key}</span><b>${formatted(a.id, key)}</b></div>`).join('')}</section>`;
  }).join('');
  const keys = ['level', 'flow', 'position']; assets.forEach((a, i) => { $(`#svg-${a.id}`).textContent = formatted(a.id, keys[i]); });
  const level = readSignal(snapshot['TK-101'].signals, 'level', '%');
  const fill = $('#tank-fill-2d'), line = $('#tank-level-2d');
  fill.setAttribute('y', String(level === null ? -24 : 24 - 48 * level / 100));
  fill.setAttribute('height', String(level === null ? 48 : 48 * level / 100));
  fill.setAttribute('fill', level === null ? 'url(#unknown-fill)' : '#75cdd0');
  line.setAttribute('d', level === null ? '' : `M-24 ${24 - 48 * level / 100} H24`);
}
function setScenario(value: Scenario) { scenario = value; snapshot = fixture(value); $('#scenario') instanceof HTMLSelectElement && (($('#scenario') as HTMLSelectElement).value = value); updateText(); advance(0); }
function advance(dt: number, draw = true) {
  time += dt;
  models.forEach((m, i) => m.update(snapshot[assets[i].id].signals, dt));
  tracks.forEach(track => {
    track.flow = readSignal(snapshot[track.asset].signals, track.signal, 'm3/h');
    track.phase = advancePhase(track.phase, (track.flow ?? 0) / 24 * .2, dt);
    track.arrows.forEach((arrow, i) => {
      arrow.visible = track.flow !== null && track.flow !== 0;
      const fraction = (track.phase + i / 3) % 1;
      arrow.position.copy(track.path.getPointAt(fraction));
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), track.path.getTangentAt(fraction).normalize().multiplyScalar((track.flow ?? 0) < 0 ? -1 : 1));
    });
  });
  if (draw) { $('#clock').textContent = `${time.toFixed(2)} s`; ($('#timeline') as HTMLInputElement).value = String(time % 8); render(); }
}
function render() {
  renderer.render(scene, camera);
  const labels: string[] = [];
  models.forEach((model, i) => {
    if (!model.root.visible) return;
    const asset = assets[i], state = snapshot[asset.id], quality = Object.values(state.signals)[0].quality;
    const labelPoint = new THREE.Vector3(0, 0, i === 0 ? asset.parameters.height + .55 : 1.75 * asset.parameters.scale).applyMatrix4(model.root.matrixWorld).project(camera);
    const status = state.alarm === 'trip' ? 'TRIP' : quality !== 'good' ? `UNKNOWN · ${quality.toUpperCase()}` : formatted(asset.id, ['level', 'rpm', 'position'][i]);
    labels.push(`<span class="asset-label ${state.alarm === 'trip' ? 'trip' : quality !== 'good' ? 'warning' : ''}" style="left:${(labelPoint.x + 1) * canvas.clientWidth / 2}px;top:${(1 - labelPoint.y) * canvas.clientHeight / 2}px"><strong>${asset.id}</strong><span>${status}</span></span>`);
    model.anchors.forEach((anchor, name) => {
      const point = anchor.getWorldPosition(new THREE.Vector3()).project(camera);
      if (point.z > 1 || point.z < -1) return;
      labels.push(`<span class="port-label" style="left:${(point.x + 1) * canvas.clientWidth / 2}px;top:${(1 - point.y) * canvas.clientHeight / 2}px">${name}</span>`);
    });
    if (selection === 'V-101') {
      for (const [caption, local] of [['0 · A', [.45, 0, 1.48]], ['100 · B', [0, -.45, 1.48]]] as const) {
        const point = new THREE.Vector3().fromArray(local).multiplyScalar(asset.parameters.scale).applyMatrix4(model.root.matrixWorld).project(camera);
        labels.push(`<span class="travel-label" style="left:${(point.x + 1) * canvas.clientWidth / 2}px;top:${(1 - point.y) * canvas.clientHeight / 2}px">${caption}</span>`);
      }
    }
  });
  $('#port-labels').innerHTML = labels.join('');
  if (selection === 'V-101') $('#port-labels').insertAdjacentHTML('beforeend', '<span class="travel-legend">Actuator travel: 0–100% · measured flows shown separately</span>');
}
const resize = () => { const bounds = $('#viewport').getBoundingClientRect(); renderer.setSize(bounds.width, bounds.height, false); camera.aspect = bounds.width / bounds.height; camera.updateProjectionMatrix(); render(); };
new ResizeObserver(resize).observe($('#viewport')); controls.addEventListener('change', render);
document.querySelectorAll<HTMLButtonElement>('[data-asset]').forEach(b => b.onclick = () => setSelection(b.dataset.asset!));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view as View));
$('#scenario').onchange = e => setScenario((e.target as HTMLSelectElement).value as Scenario);
function pause() { playing = false; $('#play').textContent = '▶ Play'; $('#play').setAttribute('aria-pressed', 'false'); }
$('#play').onclick = () => { playing = !playing; $('#play').textContent = playing ? 'Ⅱ Pause' : '▶ Play'; $('#play').setAttribute('aria-pressed', String(playing)); };
function seek(seconds: number) {
  time = 0; models.forEach(m => m.reset()); tracks.forEach(t => { t.phase = 0; });
  for (let t = 0; t < seconds - 1e-8; t += 1 / 60) advance(Math.min(1 / 60, seconds - t), false);
  advance(0);
}
$('#timeline').oninput = e => { pause(); seek(Number((e.target as HTMLInputElement).value)); };
function search() {
  const term = ($('#search') as HTMLInputElement).value.toLowerCase();
  const entries = index.categories.flatMap(c => c.symbols.map(name => ({ name, category: c.id, url: c.url }))).filter(e => `${e.name} ${e.category}`.toLowerCase().includes(term));
  $('#catalog-results').innerHTML = `<p class="result-count">${entries.length} indexed entries${entries.length > 24 ? ' · showing first 24' : ''}</p><div class="catalog-grid">${entries.slice(0, 24).map(e => `<a href="${escape(e.url)}" target="_blank" rel="noreferrer"><strong>${escape(e.name)}</strong><span>${escape(e.category.replaceAll('_', ' '))} · indexed</span></a>`).join('')}</div>`;
}
$('#search').oninput = search; search();
let previous = performance.now();
function loop(now: number) { const dt = Math.min((now - previous) / 1000, .1); previous = now; if (playing) advance(dt); requestAnimationFrame(loop); }
resize(); setScenario('normal'); setView('iso'); requestAnimationFrame(loop);
function inspect() {
  scene.updateMatrixWorld(true);
  return {
    scenario, time, selection, view: currentView, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls,
    assets: assets.map((a, i) => ({ id: a.id, metrics: models[i].metrics(), bounds: new THREE.Box3().setFromObject(models[i].root).getSize(new THREE.Vector3()).toArray(), ports: registry.get(a.type).ports(a.parameters).map(p => {
      const expected = worldPort(p, a.pose3D), actual = models[i].anchors.get(p.id)!.getWorldPosition(new THREE.Vector3());
      return { id: p.id, position: actual.toArray(), gap: actual.distanceTo(new THREE.Vector3().fromArray(expected.position)) };
    }) })),
    flows: tracks.map(t => ({ signal: t.signal, value: t.flow, phase: t.phase, arrowsVisible: t.arrows.some(a => a.visible) })),
  };
}
const api = { ready: true, setCase(options: { scenario?: Scenario; view?: View; asset?: string; time?: number }) { pause(); setScenario(options.scenario ?? 'normal'); setSelection(options.asset ?? 'all'); setView(options.view ?? 'iso'); seek(options.time ?? 1.2); return inspect(); }, inspect, advance, setScenario };
(window as unknown as { scadaLab: typeof api }).scadaLab = api;
