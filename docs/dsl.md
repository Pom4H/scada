# TypeScript DSL

A source file is the project. The parser derives a scene on every valid edit. The renderer, route cache, animation phase, selection and camera are transient.

## Declarations

Import named functions from `@scada/core`. Import aliases work. Use one declaration per `const` statement and a stable unique equipment ID. The variable is how connections refer to the equipment; the ID identifies it across rebuilds.

```ts
import { pump as createPump, valve, connect } from "@scada/core";
const GRID = 100;
const motor = createPump("P-101", { x: GRID * 3, y: 338, rpm: 1500 });
const gate = valve("V-101", { x: 700, y: 142, opening: 76 });
const discharge = connect(motor.outlet, gate.inlet);
```

`x: GRID * 3` can be rendered but is not draggable. Edit the formula in code or replace it with a literal. Absent properties use catalog defaults and are inserted into the object when edited visually. Existing literal initializers are replaced by their exact AST ranges. Formatting the entire document happens only with the explicit Format command.

Supported values: strings, finite numbers, booleans; scalar `const` references, parentheses and arithmetic `+ - * /`; `as` and `satisfies` wrappers. Supported statements: named imports, `const`, function calls in the DSL and comments. Type annotations are parsed, but this is not a general TypeScript type-checking service. DSL-specific types, value ranges and topology are checked by the compiler.

Unsupported expressions fail with a source location. No `eval`, `Function`, DOM, network calls, loops, callbacks, external modules, object spread, getters, prototype properties or arbitrary property access are evaluated. Bounds: 120,000 source characters, 48 equipment elements, bounded AST evaluation depth/work.

## Equipment

All equipment supports `quality: "good" | "stale" | "bad"` and `alarm: "none" | "warning" | "trip"`.

| Function | Physical ports | Editable process properties |
| --- | --- | --- |
| `tank` | `outlet` | `level` 0–100 % |
| `pump` | `inlet`, `outlet` (up) | `rpm` −3000…3000, `temperature`, `vibration` |
| `valve` | `inlet`, `outlet` | `opening` 0–100 % |
| `flowmeter` | `inlet`, `outlet` | Flow is derived from the demonstration circuit |
| `exchanger` | `inlet`, `outlet` | `temperature` |
| `outlet` | `inlet` | Process boundary |
| `pressure` | instrument tap | `value` 0–16 bar, `at`, `offset` |
| `temperature` | instrument tap | `value` −40…150 °C, `at`, `offset` |

Physical equipment has literal `x`, `y` in scene coordinates. Bounds and defaults are centralized in `src/core.ts`. The visual symbols share local coordinates with their ports; moving equipment cannot detach a path endpoint from its port.

## Connections and instruments

```ts
const line = connect(motor.outlet, gate.inlet);
tap(line, pressure("PT-101", { value: 5.8, at: 0.6, offset: 110 }));
```

An output connects to an input. Ports accept one physical connection in this release. Invalid port names, occupied ports, self-connections and duplicate IDs are errors. Deleting equipment removes dependent connections and taps as one source edit. A flowmeter is inline equipment with two real ports; a pressure/temperature tap does not break the main flow.

A tap follows a sufficiently long horizontal segment of its parent route. `at` chooses a point on that segment; `offset` controls instrument distance. Instruments are not freely positioned independent objects. If no safe segment exists, the layout reports it rather than drawing a detached gauge. Routes avoid other equipment bounds. Overlapping equipment and impossible routes are warnings, not silently declared valid layouts.

## Demonstration flow

For a supported complete series circuit:

```text
Q = 12 × (pump.rpm / 1500) × product(valve.opening / 100)   m³/h
```

A closed valve makes Q exactly zero. Flow quality, not decorative color, controls whether animation is shown. A trip on a pump or valve, or an empty source tank, blocks flow. The circuit must contain exactly one source and pump and terminate in an outlet. Branches, loops and multi-pump systems do not get a fictitious hydraulic solution: diagnostics explain the unsupported structure. Two separate valid circuits work independently.

Animated interpolation is a display concern. Source values and critical states are not overwritten by interpolated frames. Rotor phase integrates signed visual RPM; water phase integrates signed circuit flow. A redraw retains animation phase so changing coordinates does not restart the rotor. Reduced motion/preview pause stops motion while still accepting source edits.
