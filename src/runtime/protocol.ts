/** Data and installed metadata only: no transport or behavior execution. */
import type { ProjectSnapshot } from './project';
import { catalog } from '../core';
export type Quality = 'good' | 'stale' | 'bad' | 'offline';
interface SignalBase { unit: string; timestamp: number; quality: Quality }
export interface NumericSignal extends SignalBase { type: 'number'; value: number | null }
export interface BooleanSignal extends SignalBase { type: 'boolean'; value: boolean | null }
export interface StringSignal extends SignalBase { type: 'string'; value: string | null }
export type Signal = NumericSignal | BooleanSignal | StringSignal;
export type Alarm = 'none' | 'warning' | 'trip';
export interface EquipmentState {
  positionId: string;
  instanceId: string;
  facts: { mode: string; alarm: Alarm };
  signals: Record<string, Signal>;
}
export interface PublicEvent {
  id: string;
  seq: number;
  simTimeMs: number;
  timestamp: number;
  equipmentId?: string;
  type: string;
  message: string;
}
export type RunStatus = 'running' | 'completed' | 'failed';
export interface RuntimeFrame {
  runStatus?: RunStatus;
  type: 'snapshot' | 'update';
  runId: string;
  seq: number;
  simTimeMs: number;
  timestamp: number;
  equipment: Record<string, EquipmentState>;
  flows: Record<string, NumericSignal>;
  events: PublicEvent[];
}
export interface RuntimeConfig { server: string; project: string; run?: string }
export interface RunSummary {
  id: string;
  projectId: string;
  label: string;
  status: RunStatus;
  seq: number;
  simTimeMs: number;
  createdAt: number;
  sourceHash: string;
  synthetic: true;
  projectRevision?: string;
  projectEntry?: string;
}
export interface RunDetail extends RunSummary {
  projectSnapshot?: ProjectSnapshot;
  source: string;
  configurationVersion: string;
  behaviorVersions: Record<string, string>;
  seed: number;
  initialConditions: Record<string, unknown>;
  scenario: 'normal' | 'degradation';
}
export interface CreateRun {
  projectId: string;
  label?: string;
  source: string;
  scenario: 'normal' | 'degradation';
  seed?: number;
  projectRevision?: string;
  projectEntry?: string;
}
export interface EquipmentCommand {
  commandId: string;
  equipmentId: string;
  command: string;
  value?: number | string | boolean;
}
export interface CommandReceipt { commandId: string; accepted: true; seq: number }
export interface HistoryRange { fromMs: number; toMs: number; untilSeq: number }
export interface TrendSelection { equipmentId?: string; linkId?: string; signal: string }
export interface TrendPoint { seq: number; simTimeMs: number; value: number | null }
export interface TrendSeries { unit: string; points: TrendPoint[]; fromMs: number; toMs: number }
export interface HistoryPage { frames: RuntimeFrame[]; nextAfter: number; hasMore: boolean }
export function numeric(signal: Signal | undefined): number | null {
  return signal?.type === 'number' && signal.quality === 'good' && signal.value !== null && Number.isFinite(signal.value) ? signal.value : null;
}
/** Stable equipment configuration identity; transport metadata and TS aliases are not equipment. */
export function configurationJSON(scene: { nodes: { id: string; kind: string; props: Record<string, unknown>; tap?: string }[]; links: { id: string; from: { node: string; port: string }; to: { node: string; port: string } }[] }): string {
  const nodes = scene.nodes.map(n => ({ id: n.id, kind: n.kind, props: Object.fromEntries(Object.entries(n.props).filter(([key]) => catalog[n.kind]?.fields[key]?.scope !== 'layout').sort(([a], [b]) => a.localeCompare(b, 'en'))), ...(n.tap ? { tap: n.tap } : {}) })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const links = scene.links.map(l => ({ id: l.id, from: { node: l.from.node, port: l.from.port }, to: { node: l.to.node, port: l.to.port } })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return JSON.stringify({ nodes, links });
}
