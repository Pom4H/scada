/** All fixtures stay inside the documented DSL, range and 48-element limits. */
export const nestedTap = `import { pump, valve, connect, tap, pressure } from "@scada/core";
const p = pump("P", { x: 0, y: 220 });
const v = valve("V", { x: 500, y: 0 });
tap(connect(p.outlet, v.inlet), pressure("PT", { at: 0.5, offset: 110 }));
`;

export const collidingImport = `import { pump } from "@scada/core";
const tank = 20;
const p = pump("P", { x: tank, y: 100 });
`;

export const stackedTaps = `import { tank, pump, outlet, connect, tap, pressure, temperature } from "@scada/core";
const t = tank("T", { x: 0, y: 100 });
const p = pump("P", { x: 500, y: 188 });
const o = outlet("O", { x: 1000, y: 80 });
const inlet = connect(t.outlet, p.inlet);
connect(p.outlet, o.inlet);
tap(inlet, pressure("PT", { at: 0.5, offset: 110 }));
tap(inlet, temperature("TT", { at: 0.5, offset: 110 }));
`;

/** Deterministic, non-overlapping placement; one complete series circuit.
 * Its shuffled connections force the router to work around actual obstacles.
 * This deliberately tests a difficult layout, not a representative plant.
 */
export function crowdedCircuit(count: number, seed = 42): string {
  if (count < 3 || count > 49) throw new RangeError('Use 3–49 elements');
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const slots = Array.from({ length: count }, (_, i) => ({
    x: i % 8 * 450 + Math.round(random() * 70),
    y: Math.floor(i / 8) * 360 + Math.round(random() * 70),
  }));
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const lines = ['import { tank, pump, valve, outlet, connect } from "@scada/core";'];
  for (let i = 0; i < count; i++) {
    const kind = i === 0 ? 'tank' : i === 1 ? 'pump' : i === count - 1 ? 'outlet' : 'valve';
    lines.push(`const n${i} = ${kind}("N${i}", ${JSON.stringify(slots[i])});`);
  }
  for (let i = 1; i < count; i++) lines.push(`connect(n${i - 1}.outlet, n${i}.inlet);`);
  return lines.join('\n') + '\n';
}
