import { registry } from '../src/next/components';
import type { Asset, Quality, Sample, Signals } from '../src/next/model';
export const assets: Asset[] = [
  { ...registry.create('process.tank.vertical', 'TK-101'), pose3D: { position: [-3.1, 0, 0], rotation: [0, 0, 0, 1] }, layout2D: { x: 110, y: 65, rotation: 0 } },
  { ...registry.create('process.pump.centrifugal', 'P-101'), pose3D: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, layout2D: { x: 410, y: 65, rotation: 0 } },
  { ...registry.create('process.valve.three-way.diverting', 'V-101'), pose3D: { position: [3, 0, 0], rotation: [0, 0, 0, 1] }, layout2D: { x: 700, y: 65, rotation: 0 } },
];
export const scenarios = ['normal', 'empty', 'full', 'stopped', 'zero-flow', 'reverse', 'stale', 'bad', 'offline', 'trip', 'mismatch'] as const;
export type Scenario = typeof scenarios[number];
export type Snapshot = Record<string, { signals: Signals; alarm: 'none' | 'trip' }>;
export function fixture(scenario: Scenario): Snapshot {
  const quality: Quality = ['stale', 'bad', 'offline'].includes(scenario) ? scenario as Quality : 'good';
  const sample = (value: number, unit: string): Sample => ({ value: quality === 'offline' ? null : value, unit, timestamp: 1788825600000, quality });
  const flow = ['stopped', 'zero-flow', 'trip'].includes(scenario) ? 0 : scenario === 'reverse' ? -12 : 24;
  return {
    'TK-101': { alarm: 'none', signals: { level: sample(scenario === 'empty' ? 0 : scenario === 'full' ? 100 : 62, '%') } },
    'P-101': { alarm: scenario === 'trip' ? 'trip' : 'none', signals: { rpm: sample(['stopped', 'trip'].includes(scenario) ? 0 : 1450, 'rpm'), flow: sample(flow, 'm3/h') } },
    'V-101': { alarm: 'none', signals: { position: sample(65, '%'), command: sample(scenario === 'mismatch' ? 10 : 65, '%'), flowAB: sample(flow, 'm3/h'), flowA: sample(flow * .6, 'm3/h'), flowB: sample(flow * .4, 'm3/h') } },
  };
}
