import { catalog, directionVector, worldPort, type Scene, type Equipment, type Point, type Link } from './core';
export interface Rect { x: number; y: number; width: number; height: number; id: string }
export interface Route { points: Point[]; path: string; valid: boolean; reason?: string }
export const bounds = (n: Equipment, pad = 0): Rect => ({ id: n.id, x: Number(n.props.x) - pad, y: Number(n.props.y) - pad, width: catalog[n.kind].width + pad * 2, height: catalog[n.kind].height + pad * 2 });
const eq = (a: number, b: number) => Math.abs(a - b) < .01;
const inside = (p: Point, r: Rect) => p.x > r.x + .01 && p.x < r.x + r.width - .01 && p.y > r.y + .01 && p.y < r.y + r.height - .01;
export function segmentClear(a: Point, b: Point, boxes: Rect[]): boolean {
  if (!eq(a.x, b.x) && !eq(a.y, b.y)) return false;
  return boxes.every(r => {
    if (eq(a.x, b.x)) return !(a.x > r.x + .01 && a.x < r.x + r.width - .01 && Math.max(a.y, b.y) > r.y + .01 && Math.min(a.y, b.y) < r.y + r.height - .01);
    return !(a.y > r.y + .01 && a.y < r.y + r.height - .01 && Math.max(a.x, b.x) > r.x + .01 && Math.min(a.x, b.x) < r.x + r.width - .01);
  });
}
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const b = out.at(-1), a = out.at(-2);
    if (b && eq(b.x, p.x) && eq(b.y, p.y)) continue;
    if (a && b && ((eq(a.x, b.x) && eq(b.x, p.x)) || (eq(a.y, b.y) && eq(b.y, p.y))) && (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) >= 0) out.pop();
    out.push(p);
  }
  return out;
}
export function roundedPath(points: Point[], radius = 18): string {
  if (!points.length) return '';
  const f = (n: number) => Number(n.toFixed(2));
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), r = Math.min(radius, ab / 2, bc / 2);
    if (!ab || !bc) continue;
    d += `L${f(b.x + (a.x - b.x) * r / ab)} ${f(b.y + (a.y - b.y) * r / ab)}Q${f(b.x)} ${f(b.y)} ${f(b.x + (c.x - b.x) * r / bc)} ${f(b.y + (c.y - b.y) * r / bc)}`;
  }
  const z = points.at(-1)!; return d + `L${f(z.x)} ${f(z.y)}`;
}
/** Manhattan visibility graph with equipment clearance and bend penalty. */
export function routeLink(scene: Scene, link: Link): Route {
  const a = scene.nodes.find(n => n.id === link.from.node)!, b = scene.nodes.find(n => n.id === link.to.node)!;
  const s = worldPort(a, link.from.port), t = worldPort(b, link.to.port);
  if (eq(s.y, t.y) && s.direction === 'right' && t.direction === 'left' && t.x > s.x && segmentClear(s, t, scene.nodes.filter(n => !catalog[n.kind].instrument && n.id !== a.id && n.id !== b.id).map(n => bounds(n, 26)))) return { points: [s, t], path: roundedPath([s, t]), valid: true };
  const sv = directionVector[s.direction], tv = directionVector[t.direction], stub = 36;
  const start = { x: s.x + sv.x * stub, y: s.y + sv.y * stub }, end = { x: t.x + tv.x * stub, y: t.y + tv.y * stub };
  const physical = scene.nodes.filter(n => !catalog[n.kind].instrument);
  const boxes = physical.map(n => bounds(n, 26));
  const endpointsClear = segmentClear(s, start, boxes.filter(r => r.id !== a.id)) && segmentClear(end, t, boxes.filter(r => r.id !== b.id));
  const finish = (inner: Point[]): Route => {
    const points = simplify([s, ...inner, t]);
    const valid = endpointsClear && inner.slice(1).every((p, i) => segmentClear(inner[i], p, boxes));
    return { points, path: roundedPath(points), valid, reason: valid ? undefined : 'Порт перекрыт другим объектом' };
  };
  // Cheap routes cover normal lanes; full search is only needed around obstacles.
  const candidates = sv.y ? [[start, end], [start, { x: start.x, y: end.y }, end], [start, { x: end.x, y: start.y }, end]] : [[start, end], [start, { x: end.x, y: start.y }, end], [start, { x: start.x, y: end.y }, end]];
  for (const candidate of candidates) {
    if (candidate.slice(1).every((p, i) => segmentClear(candidate[i], p, boxes))) return finish(candidate);
  }
  const xs = [...new Set([start.x, end.x, ...boxes.flatMap(r => [r.x, r.x + r.width])])].sort((x, y) => x - y);
  const ys = [...new Set([start.y, end.y, ...boxes.flatMap(r => [r.y, r.y + r.height])])].sort((x, y) => x - y);
  const W = xs.length;
  const point = (index: number): Point => ({ x: xs[index % W], y: ys[Math.floor(index / W)] });
  const indexOf = (p: Point) => ys.indexOf(p.y) * W + xs.indexOf(p.x);
  const startIndex = indexOf(start), targetIndex = indexOf(end);
  const scores = new Map<number, number>(), previous = new Map<number, number>();
  const closed = new Set<number>();
  const queue: { key: number; score: number }[] = [];
  // A binary heap avoids sorting the entire frontier on every A* expansion.
  const push = (item: { key: number; score: number }) => {
    let i = queue.length; queue.push(item);
    while (i > 0) { const parent = (i - 1) >> 1; if (queue[parent].score <= item.score) break; queue[i] = queue[parent]; i = parent; }
    queue[i] = item;
  };
  const pop = () => {
    const first = queue[0], last = queue.pop()!;
    if (queue.length) {
      let i = 0;
      while (i * 2 + 1 < queue.length) {
        let child = i * 2 + 1;
        if (child + 1 < queue.length && queue[child + 1].score < queue[child].score) child++;
        if (queue[child].score >= last.score) break;
        queue[i] = queue[child]; i = child;
      }
      queue[i] = last;
    }
    return first;
  };
  for (let axis = 0; axis < 2; axis++) { const key = startIndex * 2 + axis; scores.set(key, 0); push({ key, score: 0 }); }
  let found: number | undefined;
  while (queue.length) {
    const key = pop().key;
    if (closed.has(key)) continue;
    closed.add(key);
    const index = Math.floor(key / 2), axis = key % 2, p = point(index), x = index % W, y = Math.floor(index / W);
    if (index === targetIndex) { found = key; break; }
    for (const [nx, ny, na] of [[x - 1, y, 0], [x + 1, y, 0], [x, y - 1, 1], [x, y + 1, 1]]) {
      if (nx < 0 || nx >= W || ny < 0 || ny >= ys.length) continue;
      const nextIndex = ny * W + nx, next = nextIndex * 2 + na, q = point(nextIndex);
      if (closed.has(next) || boxes.some(r => inside(q, r)) || !segmentClear(p, q, boxes)) continue;
      const distance = scores.get(key)! + Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + (axis !== na ? 28 : 0);
      if (distance >= (scores.get(next) ?? Infinity)) continue;
      scores.set(next, distance); previous.set(next, key);
      push({ key: next, score: distance + Math.abs(q.x - end.x) + Math.abs(q.y - end.y) });
    }
  }
  if (found !== undefined) {
    const points: Point[] = []; let key: number | undefined = found;
    while (key !== undefined) { points.push(point(Math.floor(key / 2))); key = previous.get(key); }
    return finish(points.reverse());
  }
  const points = simplify([s, start, { x: start.x, y: end.y }, end, t]);
  return { points, path: roundedPath(points), valid: false, reason: 'Нет свободного пути. Раздвиньте оборудование.' };
}
export function layout(scene: Scene): { routes: Map<string, Route>; warnings: string[] } {
  const routes = new Map<string, Route>(); const warnings: string[] = [];
  for (const link of scene.links) { const route = routeLink(scene, link); routes.set(link.id, route); if (!route.valid) warnings.push(`${link.from.node} → ${link.to.node}: ${route.reason}`); }
  const boxes = scene.nodes.filter(n => !catalog[n.kind].instrument).map(n => bounds(n));
  for (const n of scene.nodes.filter(n => catalog[n.kind].instrument && n.tap)) {
    const route = routes.get(n.tap!); if (!route) continue;
    const p = tapPoint(route, Number(n.props.at));
    boxes.push({ id: n.id, x: p.x - 33, y: p.y - Number(n.props.offset), width: catalog[n.kind].width, height: catalog[n.kind].height });
  }
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
    const a = boxes[i];
    if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) warnings.push(`Перекрытие: ${a.id} / ${b.id}`);
  }
  for (const n of scene.nodes.filter(n => catalog[n.kind].instrument)) {
    const route = routes.get(n.tap!);
    if (route && !route.points.slice(1).some((b, i) => eq(b.y, route.points[i].y) && Math.abs(b.x - route.points[i].x) >= 90)) warnings.push(`${n.id}: для отвода нужен горизонтальный участок от 90 единиц. Раздвиньте оборудование.`);
  }
  return { routes, warnings };
}
/** Attach to a straight section, not the middle of an elbow. */
export function tapPoint(route: Route, at: number): Point {
  const segments = route.points.slice(1).map((b, i) => ({ a: route.points[i], b, length: Math.hypot(b.x - route.points[i].x, b.y - route.points[i].y) }));
  const horizontal = segments.filter(s => eq(s.a.y, s.b.y) && s.length >= 90);
  const choices = horizontal.length ? horizontal : segments;
  const total = choices.reduce((sum, s) => sum + s.length, 0);
  let offset = total * at;
  for (const s of choices) { if (offset <= s.length) { const ratio = Math.min(.82, Math.max(.18, offset / s.length)); return { x: s.a.x + (s.b.x - s.a.x) * ratio, y: s.a.y + (s.b.y - s.a.y) * ratio }; } offset -= s.length; }
  return route.points[0];
}
