import { createHash, randomUUID } from 'node:crypto';
import { catalog, type Equipment, type Scene } from '../src/core';
import { compile } from '../src/source';
import type { CommandReceipt, CreateRun, EquipmentCommand, EquipmentState, NumericSignal, PublicEvent, RunDetail, RunSummary, RuntimeFrame, Signal } from '../src/runtime/protocol';
import { configurationJSON } from '../src/runtime/protocol';
import { BehaviorRegistry, quality, validateCommand, type BehaviorContext, type BehaviorOutput, type HiddenState, type Transport } from './behavior';
import { installedBehaviors } from './models';
import { RunStore } from './store';

export const STEP_MS = 100;
const unknownTransport = (): Transport => ({ flow: null, pressure: null, temperature: null });
const copy = <T>(value: T): T => structuredClone(value);
const numericSample = (value: number | null, unit: string, timestamp: number, sampleQuality: NumericSignal['quality'] = 'good'): NumericSignal => ({ type: 'number', value: sampleQuality === 'good' ? value : null, unit, timestamp, quality: value === null && sampleQuality === 'good' ? 'bad' : sampleQuality });
interface Instance { generation: number; hidden: HiddenState }
interface Checkpoint { seq: number; simTimeMs: number; randomState: number; instances: Record<string, Instance>; transport: Record<string, Transport>; linkTransport: Record<string, Transport>; topologyReported: boolean }
interface ActiveRun { manifest: RunDetail; scene: Scene; checkpoint: Checkpoint; frame: RuntimeFrame }
export class RuntimeError extends Error { constructor(message: string, public status = 400) { super(message); } }
const requiredString = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RuntimeError(`Invalid ${name}`);
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('Expected a JSON object');
  return value as Record<string, unknown>;
};
const ordered = (scene: Scene): Scene => ({ nodes: [...scene.nodes].sort((a, b) => a.id.localeCompare(b.id, 'en')), links: [...scene.links].sort((a, b) => a.id.localeCompare(b.id, 'en')) });
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new RuntimeError(`Unknown field: ${key}`); };
export function validateCreate(value: unknown): CreateRun {
  const input = object(value); exactKeys(input, ['projectId', 'label', 'source', 'scenario', 'seed']);
  requiredString(input.projectId, 'projectId', 80); requiredString(input.source, 'source', 120000);
  if (!/^[\p{L}\p{N}_.-]+$/u.test(input.projectId as string)) throw new RuntimeError('Invalid projectId');
  if (input.label !== undefined) requiredString(input.label, 'label', 120);
  if (input.scenario !== 'normal' && input.scenario !== 'degradation') throw new RuntimeError('Unknown installed scenario');
  if (input.seed !== undefined && (!Number.isInteger(input.seed) || Number(input.seed) < 0 || Number(input.seed) > 0xffffffff)) throw new RuntimeError('seed must be a uint32');
  return input as unknown as CreateRun;
}
export function validateEquipmentCommand(value: unknown): EquipmentCommand {
  const input = object(value); exactKeys(input, ['commandId', 'equipmentId', 'command', 'value']);
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(requiredString(input.commandId, 'commandId', 100))) throw new RuntimeError('Invalid commandId');
  requiredString(input.equipmentId, 'equipmentId', 48); requiredString(input.command, 'command', 48);
  if (input.value !== undefined && !['number', 'string', 'boolean'].includes(typeof input.value)) throw new RuntimeError('Invalid command value');
  if (typeof input.value === 'string' && input.value.length > 200) throw new RuntimeError('Command value is too long');
  return input as unknown as EquipmentCommand;
}
function summary(manifest: RunDetail): RunSummary {
  const { id, projectId, label, status, seq, simTimeMs, createdAt, sourceHash, synthetic } = manifest;
  return { id, projectId, label, status, seq, simTimeMs, createdAt, sourceHash, synthetic };
}
export class RunEngine {
  readonly store: RunStore;
  private runs = new Map<string, ActiveRun>();
  private listeners = new Map<string, Set<(frame: RuntimeFrame) => void>>();
  constructor(dataPath = ':memory:', readonly registry: BehaviorRegistry = installedBehaviors()) {
    this.store = new RunStore(dataPath);
    try {
      for (const persisted of this.store.load()) {
        const scene = ordered(compile(persisted.manifest.source).scene);
        for (const node of scene.nodes) if (this.registry.get(node.kind).version !== persisted.manifest.behaviorVersions[node.kind]) throw new Error(`Behavior version mismatch for saved run ${persisted.manifest.id}: ${node.kind}`);
        const metadataVersions = persisted.manifest.initialConditions.metadataVersions as Record<string, string> | undefined;
        if (metadataVersions) for (const node of scene.nodes) if (metadataVersions[node.kind] !== catalog[node.kind].version) throw new Error(`Metadata version mismatch for saved run ${persisted.manifest.id}: ${node.kind}`);
        const checkpoint = persisted.checkpoint as Checkpoint;
        const frame = this.store.frame(persisted.manifest.id, checkpoint.seq);
        if (!frame) throw new Error(`Missing durable frame for run ${persisted.manifest.id}`);
        this.runs.set(persisted.manifest.id, { manifest: persisted.manifest, scene, checkpoint, frame });
      }
    } catch (error) { this.store.close(); throw error; }
  }
  private require(id: string): ActiveRun { const run = this.runs.get(id); if (!run) throw new RuntimeError('Run not found', 404); return run; }
  list(projectId?: string): RunSummary[] { return [...this.runs.values()].filter(run => projectId === undefined || run.manifest.projectId === projectId).map(run => summary(run.manifest)); }
  get(id: string): { run: RunSummary; snapshot: RuntimeFrame } {
    const run = this.require(id); return { run: summary(run.manifest), snapshot: { ...copy(run.frame), type: 'snapshot' } };
  }
  research(id: string, after = -1, limit = 500) {
    const run = this.require(id);
    return { run: copy(run.manifest), hidden: copy(run.checkpoint.instances), checkpoint: { seq: run.checkpoint.seq, simTimeMs: run.checkpoint.simTimeMs, randomState: run.checkpoint.randomState }, assumptions: Object.fromEntries([...new Set(run.scene.nodes.map(node => node.kind))].map(kind => [kind, this.registry.get(kind).assumptions])), commands: this.store.commands(id, after, limit), events: this.store.researchEvents(id, after, limit) };
  }
  create(value: CreateRun, options: { id?: string; epoch?: number } = {}): { run: RunSummary; snapshot: RuntimeFrame } {
    const input = validateCreate(value);
    if (this.runs.size >= 100) throw new RuntimeError('Local demo limit: 100 saved runs', 409);
    const id = options.id ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || this.runs.has(id)) throw new RuntimeError('Invalid or duplicate run ID', 409);
    const epoch = options.epoch ?? Date.now();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RuntimeError('Invalid epoch');
    let scene: Scene;
    try { scene = ordered(compile(input.source).scene); } catch (error) { throw new RuntimeError(error instanceof Error ? error.message : 'Invalid source'); }
    if (!scene.nodes.length) throw new RuntimeError('A server run needs at least one component');
    const behaviorVersions: Record<string, string> = {};
    for (const node of scene.nodes) { try { behaviorVersions[node.kind] = this.registry.get(node.kind).version; } catch (error) { throw new RuntimeError((error as Error).message); } }
    const sourceHash = createHash('sha256').update(configurationJSON(scene)).digest('hex');
    const configurationVersion = createHash('sha256').update(input.source).digest('hex');
    const manifest: RunDetail = { id, projectId: input.projectId, label: input.label ?? input.projectId, status: 'running', seq: 0, simTimeMs: 0, createdAt: epoch, sourceHash, synthetic: true, source: input.source, configurationVersion, behaviorVersions, seed: input.seed ?? 1, initialConditions: {}, scenario: input.scenario };
    const checkpoint: Checkpoint = { seq: 0, simTimeMs: 0, randomState: (manifest.seed || 0x6d2b79f5) >>> 0, instances: Object.create(null), transport: Object.create(null), linkTransport: Object.create(null), topologyReported: false };
    const run = { manifest, checkpoint, scene } as ActiveRun;
    const events: PublicEvent[] = [], privateEvents: unknown[] = [];
    for (const node of scene.nodes) {
      checkpoint.transport[node.id] = unknownTransport();
      checkpoint.instances[node.id] = { generation: 1, hidden: this.registry.get(node.kind).initialize(this.context(run, node, 0, events, privateEvents)) };
    }
    manifest.initialConditions = { stepMs: STEP_MS, epoch, instances: copy(checkpoint.instances), positions: scene.nodes.map(node => ({ positionId: node.id, instanceId: `${node.id}@1`, type: node.kind })), installationRule: 'single-driver-series-v1', metadataVersions: Object.fromEntries(scene.nodes.map(node => [node.kind, catalog[node.kind].version])), behaviorAssumptions: Object.fromEntries(scene.nodes.map(node => [node.kind, [...this.registry.get(node.kind).assumptions]])) };
    run.frame = this.frame(run, events, privateEvents, 'snapshot');
    this.store.persist(manifest, checkpoint, run.frame, privateEvents);
    this.runs.set(id, run);
    return this.get(id);
  }
  private context(run: ActiveRun, node: Equipment, dtMs: number, events: PublicEvent[], privateEvents: unknown[]): BehaviorContext {
    const checkpoint = run.checkpoint;
    return {
      node, simTimeMs: checkpoint.simTimeMs, dtMs, scenario: run.manifest.scenario, transport: checkpoint.transport[node.id] ?? unknownTransport(),
      random() { let x = checkpoint.randomState; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; checkpoint.randomState = x >>> 0; return checkpoint.randomState / 4294967296; },
      emit(type, message) { events.push({ id: `${run.manifest.id}:${checkpoint.seq}:${events.length}`, seq: checkpoint.seq, simTimeMs: checkpoint.simTimeMs, timestamp: run.manifest.createdAt + checkpoint.simTimeMs, equipmentId: node.id, type, message }); },
      record(type, detail) { privateEvents.push({ type, equipmentId: node.id, instanceId: `${node.id}@${checkpoint.instances[node.id]?.generation ?? 1}`, seq: checkpoint.seq, simTimeMs: checkpoint.simTimeMs, detail: copy(detail) }); },
    };
  }
  /** One generic series installation rule. Unknown graphs produce unknown observations. */
  private transport(run: ActiveRun, outputs: Record<string, BehaviorOutput>, events: PublicEvent[]): void {
    const { scene, checkpoint } = run;
    const physical = scene.nodes.filter(node => outputs[node.id].process);
    checkpoint.transport = Object.fromEntries(scene.nodes.map(node => [node.id, unknownTransport()]));
    checkpoint.linkTransport = Object.fromEntries(scene.links.map(link => [link.id, unknownTransport()]));
    const visited = new Set<string>(); let unsupported = false;
    for (const root of physical) {
      if (visited.has(root.id)) continue;
      const ids = new Set([root.id]); const queue = [root.id];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const id = queue[cursor]; visited.add(id);
        for (const edge of scene.links) {
          const other = edge.from.node === id ? edge.to.node : edge.to.node === id ? edge.from.node : undefined;
          if (other && outputs[other]?.process && !ids.has(other)) { ids.add(other); queue.push(other); }
        }
      }
      const nodes = physical.filter(node => ids.has(node.id));
      const links = scene.links.filter(link => ids.has(link.from.node) && ids.has(link.to.node));
      const sources = nodes.filter(node => outputs[node.id].process!.boundary === 'source');
      const sinks = nodes.filter(node => outputs[node.id].process!.boundary === 'sink');
      const drivers = nodes.filter(node => outputs[node.id].process!.driverFlow !== undefined);
      const valid = sources.length === 1 && sinks.length === 1 && drivers.length === 1 && links.length === nodes.length - 1 && nodes.every(node => {
        const boundary = outputs[node.id].process!.boundary;
        const incoming = links.filter(link => link.to.node === node.id).length, outgoing = links.filter(link => link.from.node === node.id).length;
        return incoming === (boundary === 'source' ? 0 : 1) && outgoing === (boundary === 'sink' ? 0 : 1) && incoming + outgoing === Object.keys(catalog[node.kind].ports).length;
      });
      if (!valid) { unsupported = true; continue; }
      const driver = outputs[drivers[0].id].process!;
      const conductance = nodes.reduce((product, node) => product * (outputs[node.id].process!.conductance ?? 1), 1);
      const available = nodes.every(node => outputs[node.id].process!.available !== false);
      const flow = available ? driver.driverFlow! * conductance : 0;
      if (!Number.isFinite(flow)) throw new Error('Behavior produced non-finite flow');
      let current = sources[0].id, pressure = .4, temperature: number | null = null;
      for (let cursor = 0; cursor < nodes.length; cursor++) {
        const output = outputs[current].process!;
        if (output.headBar !== undefined) pressure += output.headBar * conductance;
        if (output.temperatureC !== undefined) temperature = output.temperatureC;
        const sample = { flow, pressure, temperature };
        checkpoint.transport[current] = sample;
        const link = links.find(edge => edge.from.node === current);
        if (!link) break;
        checkpoint.linkTransport[link.id] = { ...sample }; current = link.to.node;
      }
    }
    for (const node of scene.nodes) if (node.tap) checkpoint.transport[node.id] = { ...checkpoint.linkTransport[node.tap] ?? unknownTransport() };
    if (unsupported && !checkpoint.topologyReported) {
      events.push({ id: `${run.manifest.id}:${checkpoint.seq}:${events.length}`, seq: checkpoint.seq, simTimeMs: checkpoint.simTimeMs, timestamp: run.manifest.createdAt + checkpoint.simTimeMs, type: 'installation.unsupported', message: 'Расход неизвестен: серверная демо-модель поддерживает последовательную линию с одним источником, приводом и выходом.' });
      checkpoint.topologyReported = true;
    }
  }
  private frame(run: ActiveRun, events: PublicEvent[], privateEvents: unknown[], type: RuntimeFrame['type']): RuntimeFrame {
    const outputs: Record<string, BehaviorOutput> = Object.create(null);
    for (const node of run.scene.nodes) outputs[node.id] = this.registry.get(node.kind).output(run.checkpoint.instances[node.id].hidden, this.context(run, node, 0, events, privateEvents));
    this.transport(run, outputs, events);
    const timestamp = run.manifest.createdAt + run.checkpoint.simTimeMs;
    const equipment: Record<string, EquipmentState> = Object.create(null);
    for (const node of run.scene.nodes) {
      const output = this.registry.get(node.kind).output(run.checkpoint.instances[node.id].hidden, this.context(run, node, 0, events, privateEvents));
      const signals: Record<string, Signal> = {};
      for (const [name, field] of Object.entries(catalog[node.kind].signals ?? {})) {
        const value = output.signals[name] ?? null;
        if (value !== null && (typeof value !== field.type || typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Behavior produced invalid signal ${node.id}.${name}`);
        const sampleQuality = quality(node);
        signals[name] = { type: field.type, value: sampleQuality === 'good' ? value : null, unit: field.unit, timestamp, quality: value === null && sampleQuality === 'good' ? 'bad' : sampleQuality } as Signal;
      }
      equipment[node.id] = { positionId: node.id, instanceId: `${node.id}@${run.checkpoint.instances[node.id].generation}`, facts: { mode: output.mode, alarm: output.alarm }, signals };
      const previousAlarm = run.frame?.equipment[node.id]?.facts.alarm;
      if (previousAlarm !== undefined && previousAlarm !== output.alarm) this.context(run, node, 0, events, privateEvents).emit('alarm.changed', output.alarm === 'none' ? 'Показания вернулись в допустимый диапазон' : output.alarm === 'warning' ? 'Показания превысили предупредительный порог' : 'Показания достигли аварийного порога');
    }
    const flows: Record<string, NumericSignal> = {};
    for (const link of run.scene.links) {
      const from = run.scene.nodes.find(node => node.id === link.from.node)!, to = run.scene.nodes.find(node => node.id === link.to.node)!;
      const q = quality(from) === 'good' ? quality(to) : quality(from);
      flows[link.id] = numericSample(run.checkpoint.linkTransport[link.id]?.flow ?? null, 'm3/h', timestamp, q);
    }
    return { type, runId: run.manifest.id, seq: run.checkpoint.seq, simTimeMs: run.checkpoint.simTimeMs, timestamp, equipment, flows, events };
  }
  private publish(run: ActiveRun): void {
    this.runs.set(run.manifest.id, run);
    for (const listener of this.listeners.get(run.manifest.id) ?? []) { try { listener(copy(run.frame)); } catch { /* A failed subscriber never affects the durable run. */ } }
  }
  stepAll(): void { for (const id of this.runs.keys()) if (this.require(id).manifest.status === 'running') this.step(id); }
  complete(id: string): { run: RunSummary; snapshot: RuntimeFrame } {
    const previous = this.require(id);
    if (previous.manifest.status === 'completed') return this.get(id);
    const run: ActiveRun = { scene: previous.scene, manifest: copy(previous.manifest), checkpoint: copy(previous.checkpoint), frame: previous.frame };
    run.checkpoint.seq++; run.manifest.seq = run.checkpoint.seq; run.manifest.status = 'completed';
    const events: PublicEvent[] = [{ id: `${id}:${run.checkpoint.seq}:0`, seq: run.checkpoint.seq, simTimeMs: run.checkpoint.simTimeMs, timestamp: run.manifest.createdAt + run.checkpoint.simTimeMs, type: 'run.completed', message: 'Запись сценария завершена' }];
    const privateEvents: unknown[] = [];
    run.frame = this.frame(run, events, privateEvents, 'update');
    this.store.persist(run.manifest, run.checkpoint, run.frame, privateEvents); this.publish(run);
    return this.get(id);
  }
  step(id: string): RuntimeFrame {
    const previous = this.require(id);
    if (previous.manifest.status !== 'running') return copy(previous.frame);
    const run: ActiveRun = { scene: previous.scene, manifest: copy(previous.manifest), checkpoint: copy(previous.checkpoint), frame: previous.frame };
    run.checkpoint.seq++; run.checkpoint.simTimeMs += STEP_MS;
    const events: PublicEvent[] = [], privateEvents: unknown[] = [];
    for (const node of run.scene.nodes) this.registry.get(node.kind).advance(run.checkpoint.instances[node.id].hidden, this.context(run, node, STEP_MS, events, privateEvents));
    run.manifest.seq = run.checkpoint.seq; run.manifest.simTimeMs = run.checkpoint.simTimeMs;
    run.frame = this.frame(run, events, privateEvents, 'update');
    this.store.persist(run.manifest, run.checkpoint, run.frame, privateEvents); this.publish(run);
    return copy(run.frame);
  }
  command(id: string, value: EquipmentCommand): CommandReceipt {
    const command = validateEquipmentCommand(value), previous = this.require(id);
    const payload = JSON.stringify({ commandId: command.commandId, equipmentId: command.equipmentId, command: command.command, ...(command.value !== undefined ? { value: command.value } : {}) });
    const old = this.store.command(id, command.commandId);
    if (old) { if (old.payload !== payload) throw new RuntimeError('commandId was already used for another payload', 409); return copy(old.receipt); }
    if (previous.manifest.status !== 'running') throw new RuntimeError('Run is completed', 409);
    const node = previous.scene.nodes.find(item => item.id === command.equipmentId);
    if (!node) throw new RuntimeError('Equipment not found', 404);
    try { validateCommand(node, command); } catch (error) { throw new RuntimeError((error as Error).message); }
    const behavior = this.registry.get(node.kind);
    if (!behavior.command) throw new RuntimeError('No installed command handler');
    const run: ActiveRun = { scene: previous.scene, manifest: copy(previous.manifest), checkpoint: copy(previous.checkpoint), frame: previous.frame };
    run.checkpoint.seq++; run.manifest.seq = run.checkpoint.seq;
    const events: PublicEvent[] = [], privateEvents: unknown[] = [], context = this.context(run, node, 0, events, privateEvents);
    try {
      const result = behavior.command(run.checkpoint.instances[node.id].hidden, command, context);
      if (result?.replace) {
        const previousInstance = `${node.id}@${run.checkpoint.instances[node.id].generation}`;
        run.checkpoint.instances[node.id].generation++;
        context.record('installation.replaced', { previousInstance, newInstance: `${node.id}@${run.checkpoint.instances[node.id].generation}` });
      }
    } catch (error) { throw new RuntimeError((error as Error).message, 409); }
    context.emit('command.accepted', `${catalog[node.kind].commands![command.command].label}${command.value !== undefined ? `: ${command.value}` : ''}`);
    run.frame = this.frame(run, events, privateEvents, 'update');
    const receipt: CommandReceipt = { commandId: command.commandId, accepted: true, seq: run.checkpoint.seq };
    this.store.persist(run.manifest, run.checkpoint, run.frame, privateEvents, { id: command.commandId, payload, receipt }); this.publish(run);
    return receipt;
  }
  history(id: string, after = 0, limit = 500) {
    this.require(id);
    if (!Number.isSafeInteger(after) || after < -1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RuntimeError('Invalid history range');
    return this.store.history(id, after, limit);
  }
  replay(id: string, seq: number): RuntimeFrame {
    this.require(id);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new RuntimeError('Invalid replay sequence');
    const frame = this.store.frame(id, seq);
    if (!frame) throw new RuntimeError('Recorded frame not found', 404);
    return { ...frame, type: 'snapshot' };
  }
  subscribe(id: string, listener: (frame: RuntimeFrame) => void): () => void {
    this.require(id); let listeners = this.listeners.get(id);
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners); }
    listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.listeners.delete(id); };
  }
  close(): void { this.listeners.clear(); this.store.close(); }
}
