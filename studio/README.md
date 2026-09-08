# SCADA Studio

A TypeScript-first SCADA playground for GitHub Pages. The saved document is `scene.ts`; the visual scene is derived from it. Visual edits patch literal ranges in the TypeScript AST rather than maintaining a second JSON project.

## Development

```sh
cd studio
npm ci
npm run dev
```

Bun can run the same package scripts. The browser app has no server API and does not control industrial equipment.

```sh
npm run test
npm run build
npx playwright install chromium
npm run test:e2e
```

## Source contract

```ts
import { scene, tank, pump, valve, outlet, connect } from "@scada/dsl";

export default scene({
  name: "Pump station",
  nodes: [
    tank("T-101", { x: 50, y: 230, level: 64 }),
    pump("P-101", { x: 350, y: 330, rpm: 1800, demand: 12 }),
    valve("V-101", { x: 795, y: 144, opening: 76 }),
    outlet("OUT-101", { x: 1100, y: 230 }),
  ],
  links: [
    connect("T-101.outlet", "P-101.inlet"),
    connect("P-101.outlet", "V-101.inlet"),
    connect("V-101.outlet", "OUT-101.inlet"),
  ],
});
```

`@scada/dsl` names the local contract in `src/dsl.ts`; it is not a published npm package. Supported factories are `scene`, `tank`, `pump`, `valve`, `flowmeter`, `heatExchanger`, `outlet`, `pressure`, `temperature`, `connect`, and `tap`.

The playground interprets imports, const declarations, literal values, objects, arrays, port references and numeric arithmetic. It never evaluates arbitrary JavaScript, external imports, loops or functions. Expression-bound parameters remain editable in the code pane; visual controls do not silently replace expressions with literals.

## Interaction

Drag equipment to change its `x` and `y` literals. A drag is committed as one undoable source transaction. Select an object to change its parameters, data quality or alarm state. Select an output and then an input in connection mode to insert `connect()` or `tap()`. Deleting an object removes its links. Undo/redo is shared with the source editor.

Use the mouse wheel to zoom, drag the canvas background to pan, and Fit to show the whole scene. Export/import TypeScript, save a local browser draft, or share an immutable source snapshot in a URL fragment. Sharing does not provide collaboration or authorization. Do not put confidential configuration into share links.

## Rendering and model boundaries

Pipes are routed from declared ports around equipment bounds. Unroutable lines and overlapping objects are reported rather than disguised as valid geometry. The renderer uses a circular pump housing, phase-integrated SVG rotation, visible inline flowmeter flanges, and broad rectangular moving water markers. Pipe gradients use `userSpaceOnUse`, including on horizontal paths.

The flow runtime is an explicitly limited educational model: reachable tank-to-outlet paths, pump RPM/demand and valve opening determine a visual flow. A closed branch has zero flow. An independent open branch can continue. This is not a hydraulic solver, equipment driver, safety controller, telemetry implementation, or engineering design validation. Pressure and temperature are explicitly authored demo values.

## Implementation

- `src/compiler.ts`: restricted TypeScript AST interpreter, validation, source ranges and edits.
- `src/model.ts`, `src/dsl.ts`: component contracts and port metadata.
- `src/router.ts`: obstacle-aware rectilinear routing and rounded SVG paths.
- `src/runtime.ts`: bounded illustrative flow traversal.
- `src/render.ts`: SVG components and animation lifecycle.
- `src/main.ts`: CodeMirror, inspector, pointer gestures, import/export and sharing.
- `tests`: source round-trip, routing, runtime and real-browser interaction checks.

Only TypeScript source is persisted. Selection, camera and in-progress drag geometry are transient editor state. Syntax errors keep the last valid preview visible and disable visual edits until the source is valid again.
