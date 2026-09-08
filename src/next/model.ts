/** Experimental semantic contract. No dependency on a renderer or the legacy DSL. */
export type Vec3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
export type Quality = 'good' | 'stale' | 'bad' | 'offline';
export interface Sample { value: number | null; unit: string; timestamp: number; quality: Quality }
export type Signals = Readonly<Record<string, Sample>>;
export interface Pose { position: Vec3; rotation: Quaternion }
export interface Port { id: string; position: Vec3; normal: Vec3; medium: string; role: 'in' | 'out' | 'bidirectional' }
export interface Parameter { default: number; min: number; max: number; unit: string }
export interface ComponentDefinition {
  type: string;
  version: number;
  label: string;
  parameters: Readonly<Record<string, Parameter>>;
  signals: Readonly<Record<string, { unit: string; meaning: string }>>;
  ports: (parameters: Readonly<Record<string, number>>) => readonly Port[];
  references: readonly string[];
}
export interface Asset {
  id: string;
  type: string;
  parameters: Readonly<Record<string, number>>;
  /** Metres; right-handed Z-up. No implicit conversion from legacy screen pixels. */
  pose3D: Pose;
  /** Independent authored schematic position, in drawing units. */
  layout2D: { x: number; y: number; rotation: number };
}
export class ComponentRegistry {
  private definitions = new Map<string, ComponentDefinition>();
  register(definition: ComponentDefinition) {
    if (this.definitions.has(definition.type)) throw new Error(`Duplicate component: ${definition.type}`);
    this.definitions.set(definition.type, definition);
    return this;
  }
  get(type: string) {
    const result = this.definitions.get(type);
    if (!result) throw new Error(`Unknown component: ${type}`);
    return result;
  }
  create(type: string, id: string, overrides: Record<string, number> = {}): Asset {
    const definition = this.get(type), parameters: Record<string, number> = {};
    for (const key of Object.keys(overrides)) if (!(key in definition.parameters)) throw new Error(`Unknown parameter: ${key}`);
    for (const [key, field] of Object.entries(definition.parameters)) {
      const value = overrides[key] ?? field.default;
      if (!Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`Invalid ${key}: ${value}`);
      parameters[key] = value;
    }
    return { id, type, parameters, pose3D: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, layout2D: { x: 0, y: 0, rotation: 0 } };
  }
}
export function rotate(v: Vec3, q: Quaternion): Vec3 {
  const [x, y, z, w] = q;
  if (Math.abs(Math.hypot(x, y, z, w) - 1) > 1e-8) throw new Error('Rotation must be a unit quaternion');
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
export function worldPort(port: Port, pose: Pose): Port {
  const position = rotate(port.position, pose.rotation);
  return { ...port, position: position.map((x, i) => x + pose.position[i]) as unknown as Vec3, normal: rotate(port.normal, pose.rotation) };
}
export function readSignal(signals: Signals, key: string, unit: string): number | null {
  const sample = signals[key];
  return sample?.quality === 'good' && sample.unit === unit && sample.value !== null && Number.isFinite(sample.value) ? sample.value : null;
}
/** Explicit elapsed time; integrating preserves phase across speed changes. Display motion is symbolic. */
export function advancePhase(phase: number, cyclesPerSecond: number, dt: number): number {
  if (![phase, cyclesPerSecond, dt].every(Number.isFinite) || dt < 0) throw new Error('Invalid animation step');
  return ((phase + cyclesPerSecond * dt) % 1 + 1) % 1;
}
