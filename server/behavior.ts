import { catalog, type Equipment } from '../src/core';
import type { Alarm, EquipmentCommand, Quality } from '../src/runtime/protocol';

/** Behavior packages are installed code. None of these callbacks come from project text. */
export type HiddenState = Record<string, number | string | boolean | null>;
export interface Transport { flow: number | null; pressure: number | null; temperature: number | null }
export interface BehaviorContext {
  node: Equipment;
  simTimeMs: number;
  dtMs: number;
  scenario: 'normal' | 'degradation';
  transport: Transport;
  random(): number;
  emit(type: string, message: string): void;
  record(type: string, detail: HiddenState): void;
}
/** Generic installation-rule outputs. The scheduler does not know equipment kinds. */
export interface ProcessOutput {
  boundary: 'source' | 'inline' | 'sink';
  available?: boolean;
  driverFlow?: number;
  headBar?: number;
  conductance?: number;
  temperatureC?: number;
}
export interface BehaviorOutput {
  mode: string;
  alarm: Alarm;
  signals: Record<string, number | boolean | string | null>;
  process?: ProcessOutput;
}
export interface BehaviorDefinition {
  kind: string;
  version: string;
  assumptions: readonly string[];
  initialize(context: BehaviorContext): HiddenState;
  advance(state: HiddenState, context: BehaviorContext): void;
  output(state: HiddenState, context: BehaviorContext): BehaviorOutput;
  command?(state: HiddenState, command: EquipmentCommand, context: BehaviorContext): { replace?: true } | void;
}
export class BehaviorRegistry {
  private models = new Map<string, BehaviorDefinition>();
  register(definition: BehaviorDefinition): this {
    if (!Object.hasOwn(catalog, definition.kind)) throw new Error(`Behavior has no installed metadata: ${definition.kind}`);
    if (this.models.has(definition.kind)) throw new Error(`Duplicate behavior: ${definition.kind}`);
    if (!definition.version || !definition.assumptions.length) throw new Error('Behavior version and assumptions are required');
    this.models.set(definition.kind, definition);
    return this;
  }
  get(kind: string): BehaviorDefinition {
    const definition = this.models.get(kind);
    if (!definition) throw new Error(`No installed server behavior for ${kind}`);
    return definition;
  }
}
export const parameter = (node: Equipment, key: string, fallback = 0): number => typeof node.props[key] === 'number' ? node.props[key] : fallback;
export const number = (state: HiddenState, key: string): number => typeof state[key] === 'number' ? state[key] : 0;
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export function quality(node: Equipment): Quality {
  return node.props.quality === 'bad' || node.props.quality === 'stale' ? node.props.quality : 'good';
}
export function validateCommand(node: Equipment, command: EquipmentCommand): void {
  const definition = catalog[node.kind].commands?.[command.command];
  if (!definition || !Object.hasOwn(catalog[node.kind].commands!, command.command)) throw new Error(`Unknown command ${command.command} for ${node.kind}`);
  if (!definition.valueType) {
    if (command.value !== undefined) throw new Error('This command takes no value');
    return;
  }
  if (typeof command.value !== definition.valueType) throw new Error(`Command value must be ${definition.valueType}`);
  if (typeof command.value === 'number' && (!Number.isFinite(command.value) || (definition.min !== undefined && command.value < definition.min) || (definition.max !== undefined && command.value > definition.max))) throw new Error('Command value is outside the allowed range');
  if (definition.choices && !definition.choices.includes(String(command.value))) throw new Error('Unknown command value');
}
