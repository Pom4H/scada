/** Installed declarative vocabulary. Definitions are code; projects never execute it. */
import type { RuntimeConfig, Signal } from './runtime/protocol';
export type Quality = 'good' | 'stale' | 'bad';
export type Alarm = 'none' | 'warning' | 'trip';
export type Point = { x: number; y: number };
export type Direction = 'left' | 'right' | 'up' | 'down';
export type Kind = string;
export type Value = string | number | boolean;
export interface Field { scope?: 'layout' | 'behavior'; label: string; min?: number; max?: number; step?: number; unit?: string; choices?: readonly string[]; default: Value }
export interface PortSpec extends Point { direction: Direction; role: 'in' | 'out' }
export interface CommandDefinition { label: string; valueType?: 'number' | 'boolean' | 'string'; min?: number; max?: number; choices?: readonly string[] }
export interface SignalDefinition { label: string; type: Signal['type']; unit: string }
export interface Definition { label: string; width: number; height: number; fields: Record<string, Field>; ports: Record<string, PortSpec>; instrument?: boolean; version?: string; prefix?: string; signals?: Record<string, SignalDefinition>; commands?: Record<string, CommandDefinition> }
const num = (label: string, value: number, min: number, max: number, step = 1, unit = ''): Field => ({ label, default: value, min, max, step, unit });
const common: Record<string, Field> = {
  quality: { label: 'Качество', default: 'good', choices: ['good', 'stale', 'bad'] },
  alarm: { label: 'Состояние', default: 'none', choices: ['none', 'warning', 'trip'] },
};
const pos = { x: { ...num('X', 100, -3000, 6000), scope: 'layout' as const }, y: { ...num('Y', 100, -3000, 6000), scope: 'layout' as const } };
const left = (y: number): PortSpec => ({ x: 0, y, direction: 'left', role: 'in' });
const right = (x: number, y: number): PortSpec => ({ x, y, direction: 'right', role: 'out' });
export const catalog: Record<Kind, Definition> = {
  tank: { label: 'Резервуар', width: 170, height: 230, fields: { ...pos, level: num('Уровень', 64, 0, 100, 1, '%'), ...common }, ports: { outlet: right(170, 184) } },
  pump: { label: 'Насос', width: 220, height: 170, fields: { ...pos, rpm: num('Обороты', 1500, -3000, 3000, 50, 'об/мин'), temperature: num('Температура', 48, -40, 150, 1, '°C'), vibration: num('Вибрация', 1.8, 0, 20, .1, 'мм/с'), ...common }, ports: { inlet: left(96), outlet: { x: 76, y: 0, direction: 'up', role: 'out' } } },
  valve: { label: 'Клапан', width: 160, height: 164, fields: { ...pos, opening: num('Открытие', 76, 0, 100, 1, '%'), ...common }, ports: { inlet: left(102), outlet: right(160, 102) } },
  flowmeter: { label: 'Расходомер', width: 96, height: 76, fields: { ...pos, ...common }, ports: { inlet: left(38), outlet: right(96, 38) } },
  exchanger: { label: 'Теплообменник', width: 170, height: 170, fields: { ...pos, temperature: num('Температура', 72, -40, 150, 1, '°C'), ...common }, ports: { inlet: left(85), outlet: right(170, 85) } },
  outlet: { label: 'В систему', width: 44, height: 40, fields: { ...pos, ...common }, ports: { inlet: left(20) } },
  pressure: { label: 'Манометр', width: 66, height: 90, instrument: true, fields: { value: num('Давление', 5.8, 0, 16, .1, 'бар'), at: num('Точка отвода', .6, .1, .9, .05), offset: num('Отступ', 100, 80, 240, 10), ...common }, ports: {} },
  temperature: { label: 'Термометр', width: 70, height: 70, instrument: true, fields: { value: num('Температура', 72, -40, 150, 1, '°C'), at: num('Точка отвода', .5, .1, .9, .05), offset: num('Отступ', 95, 80, 240, 10), ...common }, ports: {} },
};
for (const kind of ['pressure', 'temperature']) for (const key of ['at', 'offset']) catalog[kind].fields[key].scope = 'layout';
const numericSignal = (label: string, unit: string): SignalDefinition => ({ label, type: 'number', unit });
for (const definition of Object.values(catalog)) definition.version = '1.0.0';
catalog.tank.signals = { level: numericSignal('Уровень', '%') };
catalog.pump.signals = { rpm: numericSignal('Обороты двигателя', 'rpm'), flow: numericSignal('Расход', 'm3/h'), temperature: numericSignal('Температура', '°C'), vibration: numericSignal('Вибрация', 'mm/s') };
Object.assign(catalog.pump.fields, {
  nominalFlow: num('Номинальный расход', 12, 0, 100, .1, 'м³/ч'),
  degradationRate: num('Скорость износа в сценарии', .008, 0, .1, .001, '1/с'),
  startDelay: num('Задержка запуска', 1, 0, 30, .1, 'с'),
  maintenanceSeconds: num('Длительность обслуживания', 3, .1, 60, .1, 'с'),
});
catalog.pump.commands = { start: { label: 'Запустить' }, stop: { label: 'Остановить' }, setSpeed: { label: 'Задать обороты', valueType: 'number', min: -3000, max: 3000 }, service: { label: 'Обслужить' }, replace: { label: 'Заменить экземпляр' } };
catalog.valve.signals = { opening: numericSignal('Открытие', '%'), flow: numericSignal('Расход', 'm3/h') };
catalog.valve.commands = { setOpening: { label: 'Открытие клапана', valueType: 'number', min: 0, max: 100 } };
for (const kind of ['flowmeter', 'exchanger', 'outlet']) catalog[kind].signals = { flow: numericSignal('Расход', 'm3/h') };
catalog.exchanger.signals!.temperature = numericSignal('Температура', '°C');
catalog.pressure.signals = { value: numericSignal('Давление', 'bar') };
catalog.temperature.signals = { value: numericSignal('Температура', '°C') };
/** Public extension point for metadata. Installed modules call this, never project text. */
export function registerComponent(kind: string, definition: Definition): void {
  if (!/^[a-z][a-zA-Z0-9_]{0,47}$/.test(kind) || ['__proto__', 'prototype', 'constructor', 'component', 'runtime', 'connect', 'tap'].includes(kind)) throw new Error(`Invalid component type: ${kind}`);
  if (Object.prototype.hasOwnProperty.call(catalog, kind)) throw new Error(`Duplicate component type: ${kind}`);
  if (!(Number.isFinite(definition.width) && definition.width > 0 && Number.isFinite(definition.height) && definition.height > 0) || !definition.version) throw new Error('A component needs dimensions and a version');
  for (const name of [...Object.keys(definition.fields), ...Object.keys(definition.ports), ...Object.keys(definition.signals ?? {}), ...Object.keys(definition.commands ?? {})]) if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error(`Invalid member: ${name}`);
  catalog[kind] = definition;
}
export interface Equipment { id: string; kind: Kind; props: Record<string, Value>; variable: string; tap?: string }
export interface Endpoint { node: string; port: string }
export interface Link { id: string; from: Endpoint; to: Endpoint; variable?: string }
export interface Scene { nodes: Equipment[]; links: Link[] }
export const directionVector: Record<Direction, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };
export function defaults(kind: Kind): Record<string, Value> { return Object.fromEntries(Object.entries(catalog[kind].fields).map(([key, f]) => [key, f.default])); }
export function worldPort(node: Equipment, port: string): Point & { direction: Direction } {
  const p = catalog[node.kind].ports[port];
  if (!p) throw new Error(`У ${node.id} нет порта ${port}`);
  return { x: Number(node.props.x) + p.x, y: Number(node.props.y) + p.y, direction: p.direction };
}
// The same calls also work in ordinary TypeScript outside the playground.
type Base = { x: number; y: number; quality?: Quality; alarm?: Alarm };
type InPort = Endpoint & { readonly role: 'in' };
type OutPort = Endpoint & { readonly role: 'out' };
type Inline = Equipment & { inlet: InPort; outlet: OutPort };
function create(kind: Kind, id: string, props: object): Equipment & Record<string, any> {
  if (!Object.prototype.hasOwnProperty.call(catalog, kind)) throw new Error(`Unknown component: ${kind}`);
  const node: Equipment & Record<string, any> = { kind, id, variable: '', props: { ...defaults(kind), ...props } };
  for (const [name, port] of Object.entries(catalog[kind].ports)) node[name] = { node: id, port: name, role: port.role };
  return node;
}
/** Generic factory for any installed component, including independent packages. */
export const component = (kind: string, id: string, props: Record<string, Value>) => create(kind, id, props);
/** Declarative data only. Connecting is an explicit browser operation. */
export const runtime = (configuration: RuntimeConfig): RuntimeConfig => ({ ...configuration });
export const tank = (id: string, props: Base & { level?: number }) => create('tank', id, props) as Equipment & { outlet: OutPort };
export const pump = (id: string, props: Base & { rpm?: number; temperature?: number; vibration?: number; nominalFlow?: number; degradationRate?: number; startDelay?: number; maintenanceSeconds?: number }) => create('pump', id, props) as Inline;
export const valve = (id: string, props: Base & { opening?: number }) => create('valve', id, props) as Inline;
export const flowmeter = (id: string, props: Base) => create('flowmeter', id, props) as Inline;
export const exchanger = (id: string, props: Base & { temperature?: number }) => create('exchanger', id, props) as Inline;
export const outlet = (id: string, props: Base) => create('outlet', id, props) as Equipment & { inlet: InPort };
export const pressure = (id: string, props: { value?: number; at?: number; offset?: number; quality?: Quality; alarm?: Alarm }) => create('pressure', id, props) as Equipment;
export const temperature = (id: string, props: { value?: number; at?: number; offset?: number; quality?: Quality; alarm?: Alarm }) => create('temperature', id, props) as Equipment;
export const connect = (from: OutPort, to: InPort): Link => ({ id: `${from.node}.${from.port}:${to.node}.${to.port}`, from, to });
export const tap = (line: Link, instrument: Equipment): Equipment => ({ ...instrument, tap: line.id });

/** Explicit, deliberately simple series-circuit DEMO. Not a hydraulic solver. */
export function simulate(scene: Scene): { flows: Map<string, number | null>; notes: string[] } {
  const flows = new Map<string, number | null>();
  const notes: string[] = [];
  const physical = scene.nodes.filter(n => !catalog[n.kind].instrument);
  const visited = new Set<string>();
  for (const root of physical) {
    if (visited.has(root.id)) continue;
    const ids = new Set([root.id]); const queue = [root.id];
    while (queue.length) {
      const id = queue.shift()!; visited.add(id);
      for (const edge of scene.links) {
        const other = edge.from.node === id ? edge.to.node : edge.to.node === id ? edge.from.node : null;
        if (other && !ids.has(other)) { ids.add(other); queue.push(other); }
      }
    }
    const nodes = physical.filter(n => ids.has(n.id));
    const edges = scene.links.filter(l => ids.has(l.from.node));
    if (!edges.length) continue;
    const pumps = nodes.filter(n => n.kind === 'pump');
    const degree = (id: string) => edges.filter(l => l.from.node === id || l.to.node === id).length;
    const complete = nodes.every(n => degree(n.id) === (n.kind === 'tank' || n.kind === 'outlet' ? 1 : 2)) && nodes.filter(n => n.kind === 'tank').length === 1 && nodes.filter(n => n.kind === 'outlet').length === 1 && pumps.length === 1;
    let flow: number | null = null;
    if (!complete) { notes.push('Незамкнутая или разветвлённая линия: демо-расход не рассчитывается.'); }
    else if (nodes.some(n => n.props.quality !== 'good')) { flow = null; notes.push('Качество данных не good: движение остановлено, расход неизвестен.'); }
    else if (nodes.some(n => (n.kind === 'pump' || n.kind === 'valve') && n.props.alarm === 'trip') || nodes.some(n => n.kind === 'tank' && Number(n.props.level) <= 0)) { flow = 0; }
    else {
      flow = 12 * Number(pumps[0].props.rpm) / 1500;
      for (const n of nodes.filter(n => n.kind === 'valve')) flow *= Number(n.props.opening) / 100;
      if (Math.abs(flow) < .001) flow = 0;
    }
    for (const n of nodes) flows.set(n.id, flow);
    for (const l of edges) flows.set(l.id, flow);
  }
  return { flows, notes: [...new Set(notes)] };
}
