import { ComponentRegistry, type ComponentDefinition, type Port } from './model';
const port = (id: string, position: Port['position'], normal: Port['normal'], role: Port['role'] = 'bidirectional'): Port => ({ id, position, normal, medium: 'water', role });
const parameter = (value: number, min: number, max: number) => ({ default: value, min, max, unit: 'm' });
export const tank: ComponentDefinition = {
  type: 'process.tank.vertical', version: 1, label: 'Vertical tank',
  parameters: { radius: parameter(.82, .4, 1.4), height: parameter(2.2, 1, 4) },
  signals: { level: { unit: '%', meaning: 'Measured liquid height in the cylindrical working volume' } },
  ports: p => [port('OUT', [p.radius + .28, 0, .48], [1, 0, 0], 'out')],
  references: ['dexpi:Equipment/Tank', 'drawio:pid/vessels'],
};
export const pump: ComponentDefinition = {
  type: 'process.pump.centrifugal', version: 1, label: 'Centrifugal pump',
  parameters: { scale: { default: 1, min: .6, max: 1.6, unit: 'ratio' } },
  signals: {
    rpm: { unit: 'rpm', meaning: 'Measured drive speed, independent of fluid flow' },
    flow: { unit: 'm3/h', meaning: 'Signed measured flow, positive IN to OUT' },
  },
  ports: p => [port('IN', [-.95 * p.scale, 0, .65 * p.scale], [-1, 0, 0], 'in'), port('OUT', [-.25 * p.scale, 0, 1.35 * p.scale], [0, 0, 1], 'out')],
  references: ['dexpi:Equipment/CentrifugalPump', 'drawio:pid/pumps'],
};
export const valve: ComponentDefinition = {
  type: 'process.valve.three-way.diverting', version: 1, label: 'Three-way diverting valve',
  parameters: { scale: { default: 1, min: .6, max: 1.6, unit: 'ratio' } },
  signals: {
    position: { unit: '%', meaning: 'Measured actuator travel; not a flow split' },
    command: { unit: '%', meaning: 'Requested actuator position, displayed separately from feedback' },
    flowAB: { unit: 'm3/h', meaning: 'Positive into common port AB' },
    flowA: { unit: 'm3/h', meaning: 'Positive out of A' },
    flowB: { unit: 'm3/h', meaning: 'Positive out of B' },
  },
  ports: p => [port('AB', [-.75 * p.scale, 0, .65 * p.scale], [-1, 0, 0], 'in'), port('A', [.75 * p.scale, 0, .65 * p.scale], [1, 0, 0], 'out'), port('B', [0, -.75 * p.scale, .65 * p.scale], [0, -1, 0], 'out')],
  references: ['drawio:pid/valves', 'dexpi:Piping'],
};
export const registry = new ComponentRegistry().register(tank).register(pump).register(valve);
