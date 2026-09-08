import { catalog, simulate, type Equipment, type Scene, type Point } from './core';
import { layout, tapPoint, type Route } from './geometry';
const NS = 'http://www.w3.org/2000/svg';
export function el<K extends keyof SVGElementTagNameMap>(parent: SVGElement, tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node); return node;
}
const label = (g: SVGElement, x: number, y: number, text: string, size = 12, anchor = 'middle', color = '#38566a') => el(g, 'text', { x, y, fill: color, 'font-size': size, 'text-anchor': anchor, 'font-family': 'ui-monospace, SFMono-Regular, Consolas, monospace', 'font-weight': 600 }, text);
const part = (g: SVGElement, name: string, attrs: Record<string, string | number> = {}) => el(g, 'g', { 'data-part': name, ...attrs });
const bolt = (g: SVGElement, x: number, y: number, r = 2) => { el(g, 'circle', { cx: x, cy: y, r, fill: '#78949f', stroke: '#eff6f7', 'stroke-width': .8 }); };
const pipeAttrs = { fill: 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' };
let serial = 0;
export class SceneView {
  scene: Scene = { nodes: [], links: [] };
  routes = new Map<string, Route>(); warnings: string[] = [];
  selected: string | null = null; paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  flows = new Map<string, number | null>(); notes: string[] = [];
  private layers: SVGGElement; private updates: ((dt: number) => void)[] = [];
  // Disposable render cache only. The TypeScript document remains authoritative.
  private geometryKey = '';
  private renderedNodes = new Map<string, Equipment>();
  private roots = new Map<string, { root: SVGGElement; status: SVGTextElement }>();
  private visual = new Map<string, Record<string, number>>(); private phases = new Map<string, number>();
  private last = 0; private raf = 0; private uid = `scada-${++serial}`;
  camera = { x: 0, y: 0, width: 1500, height: 620 };
  onFrame?: () => void;
  constructor(public svg: SVGSVGElement) {
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Редактируемая SCADA схема');
    const defs = el(svg, 'defs');
    for (const [id, stops] of [['metal', ['#e2ebee', '#a9bec7', '#809ca8']], ['dark', ['#335a6b', '#183f50', '#11303e']]] as const) {
      const gradient = el(defs, 'linearGradient', { id: this.id(id), x1: 0, y1: 0, x2: 1, y2: 0 });
      stops.forEach((color, i) => el(gradient, 'stop', { offset: i / 2, 'stop-color': color }));
    }
    this.layers = el(svg, 'g', { 'data-scene': '' });
    const frame = (time: number) => {
      const dt = Math.min(.25, this.last ? (time - this.last) / 1000 : 0); this.last = time;
      for (const update of this.updates) update(dt);
      this.onFrame?.(); this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame); this.setCamera(this.camera);
  }
  private id(name: string) { return `${this.uid}-${name}`; }
  private paint(name: string) { return `url(#${this.id(name)})`; }
  private value(n: Equipment, key: string, dt: number): number {
    let values = this.visual.get(n.id); if (!values) { values = {}; this.visual.set(n.id, values); }
    const target = Number(n.props[key]); const old = values[key] ?? target;
    if (n.props.quality !== 'good') return old;
    values[key] = Math.abs(target - old) < .03 || this.paused ? target : old + (target - old) * (1 - Math.exp(-dt * 10));
    return values[key];
  }
  private phase(key: string, speed: number, dt: number): number { const next = (this.phases.get(key) ?? 0) + (this.paused ? 0 : speed * dt); this.phases.set(key, next); return next; }
  setCamera(c: typeof this.camera) { this.camera = c; this.svg.setAttribute('viewBox', `${c.x} ${c.y} ${c.width} ${c.height}`); }
  point(clientX: number, clientY: number): Point { const matrix = this.svg.getScreenCTM(); return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : { x: 0, y: 0 }; }
  fit() {
    const b = this.layers.getBBox(); if (!b.width || !b.height) { this.setCamera({ x: 0, y: 0, width: 1400, height: 600 }); return; }
    this.setCamera({ x: b.x - 46, y: b.y - 44, width: b.width + 92, height: b.height + 88 });
  }
  zoom(factor: number) { const c = this.camera; const width = Math.max(220, Math.min(12000, c.width * factor)), height = width / c.width * c.height; this.setCamera({ x: c.x + (c.width - width) / 2, y: c.y + (c.height - height) / 2, width, height }); }
  select(id: string | null) { this.selected = id; this.layers.querySelectorAll('[data-node], [data-edge]').forEach(n => n.classList.toggle('selected', id !== null && (n.getAttribute('data-node') === id || n.getAttribute('data-edge') === id))); }
  render(scene: Scene) {
    this.scene = scene;
    const sim = simulate(scene); this.flows = sim.flows; this.notes = sim.notes;
    // Parameters/quality do not change routing. Keep DOM nodes and animation
    // closures alive; refresh only the derived props they read on the next frame.
    const key = JSON.stringify([
      scene.nodes.map(n => [n.id, n.kind, n.tap, n.props.x, n.props.y, n.props.at, n.props.offset]),
      scene.links,
    ]);
    if (key === this.geometryKey) {
      for (const n of scene.nodes) this.renderedNodes.get(n.id)!.props = { ...n.props };
      this.syncStatuses();
      for (const update of this.updates) update(0);
      return;
    }
    this.geometryKey = key; this.updates = []; this.roots.clear();
    this.renderedNodes = new Map(scene.nodes.map(n => [n.id, { ...n, props: { ...n.props } }]));
    // Remove animation state for deleted items as well as rendered values.
    const phaseKeys = new Set([...scene.links.map(l => l.id), ...scene.nodes.map(n => `${n.id}:rotor`)]);
    for (const id of this.phases.keys()) if (!phaseKeys.has(id)) this.phases.delete(id);
    for (const id of this.visual.keys()) if (!scene.nodes.some(n => n.id === id)) this.visual.delete(id);
    const geometry = layout(scene); this.routes = geometry.routes; this.warnings = geometry.warnings;
    this.layers.replaceChildren(); const pipes = el(this.layers, 'g'), devices = el(this.layers, 'g'), instruments = el(this.layers, 'g');
    for (const edge of scene.links) {
      const route = this.routes.get(edge.id)!;
      const g = el(pipes, 'g', { 'data-edge': edge.id, class: `edge${route.valid ? '' : ' invalid'}`, tabindex: 0, role: 'button', 'aria-label': `Труба ${edge.from.node} → ${edge.to.node}` });
      el(g, 'path', { d: route.path, ...pipeAttrs, stroke: '#7d9aa6', 'stroke-width': 26 });
      el(g, 'path', { d: route.path, ...pipeAttrs, stroke: '#d5e4e9', 'stroke-width': 22 });
      const water = el(g, 'path', { d: route.path, ...pipeAttrs, stroke: route.valid ? '#08a7c5' : '#ca6661', 'stroke-width': 18, 'data-water': edge.id });
      const flow = el(g, 'path', { d: route.path, ...pipeAttrs, stroke: '#a0eef4', 'stroke-width': 12, 'stroke-dasharray': '36 30', 'data-flow': edge.id });
      const hit = el(g, 'g', { class: 'edge-hit' });
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i];
        el(hit, 'rect', { x: Math.min(a.x, b.x) - 10, y: Math.min(a.y, b.y) - 10, width: Math.abs(a.x - b.x) + 20, height: Math.abs(a.y - b.y) + 20, fill: 'transparent' });
      }
      this.updates.push(dt => { const q = route.valid ? this.flows.get(edge.id) : 0; const phase = this.phase(edge.id, q == null ? 0 : q * 4.5, dt); flow.setAttribute('stroke-dashoffset', String(-phase % 66)); flow.setAttribute('opacity', q == null ? '0' : '.8'); water.setAttribute('stroke', !route.valid ? '#ca6661' : q == null ? '#b5c8d1' : '#08a7c5'); });
    }
    for (const n of [...this.renderedNodes.values()].filter(n => !catalog[n.kind].instrument)) this.equipment(devices, n);
    for (const n of [...this.renderedNodes.values()].filter(n => catalog[n.kind].instrument)) this.instrument(instruments, n);
    this.syncStatuses(); this.select(this.selected);
    for (const fn of this.updates) fn(0);
  }
  private root(parent: SVGGElement, n: Equipment, x: number, y: number): SVGGElement {
    const d = catalog[n.kind];
    const g = el(parent, 'g', { transform: `translate(${x} ${y})`, 'data-node': n.id, 'data-kind': n.kind, 'data-quality': String(n.props.quality), 'data-alarm': String(n.props.alarm), class: 'node', tabindex: 0, role: 'button', 'aria-label': `${n.id} ${d.label}` });
    el(g, 'rect', { x: -10, y: -53, width: d.width + 20, height: d.height + 77, rx: 7, class: 'selection', fill: 'none', stroke: '#16a4b7', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' });
    const header = el(g, 'g', { class: 'object-label' });
    label(header, 0, -30, n.id, 18, 'start', '#224f63');
    el(header, 'text', { x: 0, y: -11, fill: '#738e9b', 'font-size': 14, 'font-family': 'system-ui, sans-serif' }, d.label);
    // Reserve a separate line for exceptional state: it must never cover the ID.
    const status = label(g, 0, d.height + 18, '', 11, 'start');
    this.roots.set(n.id, { root: g, status });
    return g;
  }
  private syncStatuses() {
    for (const [id, { root, status }] of this.roots) {
      const n = this.renderedNodes.get(id)!;
      const quality = String(n.props.quality), alarm = String(n.props.alarm);
      root.setAttribute('data-quality', quality); root.setAttribute('data-alarm', alarm);
      status.textContent = quality !== 'good' ? quality.toUpperCase() : alarm !== 'none' ? alarm.toUpperCase() : '';
      status.setAttribute('fill', quality !== 'good' ? '#6a8190' : '#bd5145');
    }
  }
  private equipment(parent: SVGGElement, n: Equipment) {
    const d = catalog[n.kind], g = this.root(parent, n, Number(n.props.x), Number(n.props.y));
    const metal = this.paint('metal'), dark = this.paint('dark');
    const body = part(g, 'body');
    const rect = (x: number, y: number, width: number, height: number, rx = 2, fill = metal) => el(body, 'rect', { x, y, width, height, rx, fill, stroke: '#718e9c', 'stroke-width': 1.4 });
    if (n.kind === 'tank') {
      el(body, 'ellipse', { cx: 79, cy: 226, rx: 67, ry: 4, fill: '#1c4055', opacity: .07 });
      rect(28, 193, 12, 31, 1, dark); rect(120, 193, 12, 31, 1, dark);
      rect(120, 172, 50, 24); rect(157, 167, 11, 34);
      el(body, 'path', { d: 'M18 42 C18 15 140 15 140 42V193C140 218 18 218 18 193Z', fill: '#e4f2f5', 'fill-opacity': .65, stroke: '#86a2ae', 'stroke-width': 2 });
      const clipId = this.id(`tank-${n.id}`), defs = el(body, 'defs'), clip = el(defs, 'clipPath', { id: clipId });
      el(clip, 'path', { d: 'M23 45C23 24 135 24 135 45V192C135 211 23 211 23 192Z' });
      const water = el(body, 'g', { 'clip-path': `url(#${clipId})` });
      const fluid = el(water, 'rect', { x: 20, y: 90, width: 120, height: 125, fill: '#11b1ca' });
      const surface = el(water, 'ellipse', { cx: 79, cy: 90, rx: 60, ry: 9, fill: '#89e5ef', stroke: '#ddffff', 'stroke-width': 1 });
      el(body, 'path', { d: 'M29 52V187M34 58V183', stroke: '#fff', 'stroke-width': 2.5, opacity: .5 });
      el(body, 'ellipse', { cx: 79, cy: 41, rx: 61, ry: 15, fill: metal, stroke: '#86a2ae', 'stroke-width': 1.5 });
      rect(68, 3, 23, 25, 1);
      const value = label(body, 79, 135, '', 22, 'middle', '#12475e');
      this.updates.push(dt => { const v = this.value(n, 'level', dt), y = 195 - v * 1.44; fluid.setAttribute('y', String(y)); fluid.setAttribute('height', String(215 - y)); surface.setAttribute('cy', String(y)); value.textContent = n.props.quality === 'bad' ? '—' : `${Math.round(v)}%`; water.setAttribute('opacity', n.props.quality === 'bad' ? '0' : '1'); });
    } else if (n.kind === 'pump') {
      el(body, 'ellipse', { cx: 118, cy: 160, rx: 95, ry: 5, fill: '#254e60', opacity: .07 });
      el(body, 'path', { d: 'M40 132 32 151H109L100 132M143 130 138 151H207L200 130', fill: dark, stroke: '#547685' });
      rect(25, 151, 190, 7); [34, 107, 142, 205].forEach(x => bolt(body, x, 154, 1.7));
      rect(0, 84, 40, 24); rect(0, 79, 10, 34); [84, 108].forEach(y => bolt(body, 5, y, 1.7));
      rect(64, 0, 24, 57); rect(58, 1, 36, 9); [64, 87].forEach(x => bolt(body, x, 5, 1.7));
      rect(114, 82, 23, 26); rect(129, 57, 81, 77, 13, dark);
      for (let x = 141; x < 202; x += 7) { el(body, 'path', { d: `M${x} 65V126`, stroke: '#0b2c3c', 'stroke-width': 3.5 }); el(body, 'path', { d: `M${x + 1} 66V125`, stroke: '#65818e', 'stroke-width': 1 }); }
      rect(203, 66, 12, 60, 6, dark); rect(155, 40, 29, 21, 3, dark);
      el(body, 'circle', { cx: 76, cy: 96, r: 48, fill: metal, stroke: '#7b97a3', 'stroke-width': 2 });
      el(body, 'circle', { cx: 76, cy: 96, r: 39, fill: dark, stroke: '#acbfc7', 'stroke-width': 3 });
      el(body, 'circle', { cx: 76, cy: 96, r: 32, fill: '#143e50', stroke: '#deedf1', 'stroke-width': 1.3 });
      const rotor = part(body, 'rotor');
      for (let angle = 0; angle < 360; angle += 72) el(rotor, 'path', { d: 'M76 91C83 87 96 86 101 75C105 89 94 101 82 104Z', transform: `rotate(${angle} 76 96)`, fill: metal, stroke: '#abc0c9', 'stroke-width': .65 });
      el(body, 'circle', { cx: 76, cy: 96, r: 8, fill: metal, stroke: '#718f9c' });
      for (let angle = 0; angle < 360; angle += 60) bolt(body, 76 + 43 * Math.cos(angle * Math.PI / 180), 96 + 43 * Math.sin(angle * Math.PI / 180), 2.3);
      const value = label(body, 171, 149, '', 9); const lamp = el(body, 'circle', { cx: 141, cy: 145, r: 2.4 });
      this.updates.push(dt => { const rpm = this.value(n, 'rpm', dt), stopped = n.props.quality !== 'good' || n.props.alarm === 'trip'; const angle = this.phase(`${n.id}:rotor`, stopped || Math.abs(rpm) < 1 ? 0 : rpm / 10, dt); rotor.setAttribute('transform', `rotate(${angle % 360} 76 96)`); value.textContent = n.props.quality !== 'good' ? String(n.props.quality) : stopped ? 'TRIP' : Math.abs(rpm) < 1 ? 'СТОП' : 'РАБОТА'; lamp.setAttribute('fill', n.props.quality !== 'good' ? '#91a7af' : stopped ? '#cd6152' : Math.abs(rpm) < 1 ? '#91a7af' : '#23a381'); });
    } else if (n.kind === 'valve') {
      rect(0, 90, 160, 24); [7, 137].forEach(x => { rect(x, 81, 13, 42, 3); [88, 116].forEach(y => bolt(body, x + 6.5, y)); });
      el(body, 'path', { d: 'M43 88 62 72H98L119 88V116L98 132H62L43 116Z', fill: metal, stroke: '#6d8d9b', 'stroke-width': 1.4 });
      rect(57, 88, 46, 29, 6, '#0ca6c0');
      const gate = el(body, 'rect', { x: 59, y: 90, width: 42, height: 25, rx: 2, fill: metal, stroke: '#587d90', 'data-part': 'gate' });
      const stem = part(body, 'stem'); el(stem, 'rect', { x: 77, y: 40, width: 6, height: 42, rx: 1, fill: metal, stroke: '#66899c' });
      el(body, 'path', { d: 'M61 73V31H99V73M57 73H104', fill: 'none', stroke: '#5f7f8f', 'stroke-width': 4 });
      rect(51, 6, 58, 28, 6, dark); rect(60, 13, 40, 9, 2, '#9abcc9');
      const value = label(body, 80, 156, '', 14);
      this.updates.push(dt => { const v = this.value(n, 'opening', dt); gate.setAttribute('height', String(25 * (1 - v / 100))); gate.setAttribute('opacity', v > 99.9 ? '0' : '1'); stem.setAttribute('transform', `translate(0 ${-v * .11})`); gate.setAttribute('visibility', n.props.quality === 'bad' ? 'hidden' : 'visible'); stem.setAttribute('visibility', n.props.quality === 'bad' ? 'hidden' : 'visible'); value.textContent = n.props.quality === 'bad' ? '—' : `${Math.round(v)}%`; });
    } else if (n.kind === 'flowmeter') {
      rect(0, 26, 96, 24); [0, 87].forEach(x => { rect(x, 16, 9, 44, 2); [23, 53].forEach(y => bolt(body, x + 4.5, y, 1.8)); });
      el(body, 'circle', { cx: 48, cy: 38, r: 32, fill: '#f1f8fa', stroke: '#7b9aa7', 'stroke-width': 3 });
      el(body, 'circle', { cx: 48, cy: 38, r: 25, fill: '#163e51', stroke: '#bed3dd', 'stroke-width': 1 });
      const value = label(body, 48, 43, '', 13, 'middle', '#b9f6fd');
      this.updates.push(() => { const q = this.flows.get(n.id); value.textContent = q == null || n.props.quality === 'bad' ? '—' : `${q > 0 ? '+' : ''}${q.toFixed(1)}`; });
    } else if (n.kind === 'exchanger') {
      rect(0, 73, 170, 24); [0, 160].forEach(x => { rect(x, 64, 10, 42, 2); [71, 99].forEach(y => bolt(body, x + 5, y)); });
      rect(20, 25, 130, 115, 20); rect(32, 37, 106, 90, 13, dark);
      const coil = el(body, 'path', { d: 'M45 53H121Q128 53 128 62Q128 70 121 70H49Q42 70 42 80Q42 89 49 89H121Q128 89 128 98Q128 109 121 109H45', fill: 'none', stroke: '#37c4d0', 'stroke-width': 7, 'stroke-linecap': 'round' });
      const value = label(body, 85, 162, '', 14);
      this.updates.push(dt => { const v = this.value(n, 'temperature', dt); value.textContent = n.props.quality === 'bad' ? '—' : `${Math.round(v)} °C`; coil.setAttribute('stroke', n.props.quality === 'bad' ? '#91a7af' : v > 90 ? '#dd9c62' : '#37c4d0'); });
    } else if (n.kind === 'outlet') {
      el(body, 'path', { d: 'M0 10H22V2L43 20 22 38V30H0Z', fill: metal, stroke: '#668c9c', 'stroke-width': 1.5 });
    }
    const hit = el(g, 'rect', { x: -5, y: -52, width: d.width + 10, height: d.height + 57, fill: 'transparent', class: 'node-hit' });
    hit.setAttribute('aria-hidden', 'true');
    const ports = el(g, 'g', { class: 'ports' });
    for (const [name, p] of Object.entries(d.ports)) {
      const port = el(ports, 'circle', { cx: p.x, cy: p.y, r: 7, fill: '#f5fafb', stroke: '#159aac', 'stroke-width': 2.5, 'data-port': name, 'data-owner': n.id, 'data-role': p.role, tabindex: 0, role: 'button', 'aria-label': `${n.id}.${name}` });
      el(port, 'title', {}, `${name} · ${p.role === 'out' ? 'начать соединение' : 'вход'}`);
    }
  }
  private instrument(parent: SVGGElement, n: Equipment) {
    const route = this.routes.get(n.tap!); if (!route) return;
    const p = tapPoint(route, Number(n.props.at)), offset = Number(n.props.offset), x = p.x - 33, y = p.y - offset;
    const g = this.root(parent, n, x, y); const metal = this.paint('metal');
    el(g, 'path', { d: `M33 62V${offset}`, stroke: '#809eaa', 'stroke-width': 2, fill: 'none' });
    el(g, 'circle', { cx: 33, cy: offset, r: 3.5, fill: '#f3f8fa', stroke: '#638b9c', 'stroke-width': 1.5 });
    if (n.kind === 'pressure') {
      el(g, 'circle', { cx: 33, cy: 33, r: 30, fill: '#f7fbfc', stroke: '#7494a3', 'stroke-width': 2.5 });
      el(g, 'circle', { cx: 33, cy: 33, r: 24, fill: '#edf4f7', stroke: '#bacdd7' });
      for (let i = 0; i <= 8; i++) { const a = (135 + i * 33.75) * Math.PI / 180; el(g, 'path', { d: `M${33 + 19 * Math.cos(a)} ${33 + 19 * Math.sin(a)}L${33 + 23 * Math.cos(a)} ${33 + 23 * Math.sin(a)}`, stroke: '#6c8b9a', 'stroke-width': 1.2 }); }
      const needle = el(g, 'path', { d: 'M30 31L54 33 30 35Z', fill: '#ce6154', 'data-part': 'needle' }); el(g, 'circle', { cx: 33, cy: 33, r: 3.5, fill: '#55788a' });
      el(g, 'rect', { x: -2, y: 65, width: 72, height: 21, rx: 4, fill: '#f4f8fa' }); const value = label(g, 33, 80, '', 12);
      this.updates.push(dt => { const v = this.value(n, 'value', dt); needle.setAttribute('transform', `rotate(${135 + v / 16 * 270} 33 33)`); needle.setAttribute('opacity', n.props.quality === 'bad' ? '0' : '1'); value.textContent = n.props.quality === 'bad' ? '—' : `${v.toFixed(1)} бар`; });
    } else {
      el(g, 'rect', { x: -5, y: 15, width: 76, height: 46, rx: 8, fill: metal, stroke: '#7796a4', 'stroke-width': 1.5 });
      el(g, 'rect', { x: 1, y: 21, width: 64, height: 34, rx: 5, fill: '#163e50' }); const value = label(g, 33, 43, '', 13, 'middle', '#bbf1f7');
      this.updates.push(dt => { const v = this.value(n, 'value', dt); value.textContent = n.props.quality === 'bad' ? '—' : `${Math.round(v)} °C`; });
    }
  }
  dispose() { cancelAnimationFrame(this.raf); }
}
