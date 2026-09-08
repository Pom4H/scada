# SCADA playground

[Open the editor](https://pom4h.github.io/scada/) · [DSL reference](docs/dsl.md) · [Architecture](docs/architecture.md) · [Experimental 3D lab and catalog](docs/3d-foundation.md)

A browser workbench for designing animated SCADA diagrams in TypeScript. Code, canvas and property inspector edit **one `scene.ts` document**. The playground is a static site; no account, backend, CDN or API key is required.

```ts
import { tank, pump, valve, outlet, connect } from "@scada/core";

const source = tank("T-101", { x: 40, y: 250, level: 64 });
const motor = pump("P-101", { x: 325, y: 338, rpm: 1500 });
const gate = valve("V-101", { x: 700, y: 142, opening: 76 });
const process = outlet("OUT", { x: 1000, y: 224 });

connect(source.outlet, motor.inlet);
connect(motor.outlet, gate.inlet);
connect(gate.outlet, process.inlet);
```

Drag `P-101`: its literal `x` and `y` change in the editor. Change `opening`: the same property changes in TypeScript. A complete drag is one undo operation. Comments, surrounding code, quote style and unrelated properties survive these source edits. Code is never reconstructed from SVG or a separately saved JSON model.

## Using the editor

Select equipment to edit its position, process parameters, quality and alarm. Drag equipment to move it; hold Alt for one-unit placement instead of the ten-unit grid. Click **Connect**, then an output and an input port. Select a pipe to add a pressure or temperature tap. Add equipment from the palette; Delete removes the selected item and dependent connections/taps. Undo and redo work across both code and visual edits.

Scroll to zoom; drag empty space or Space-drag to pan; **Fit** or F fits the scene. The code-pane divider is draggable and keyboard-accessible. On a phone, use the Code / Diagram / Properties tabs. Zoom in to work on small equipment, then Fit to see the whole circuit.

Projects are saved locally as TypeScript. Export `.ts` for version control or transfer; import opens that exact source. Share copies a link with source encoded in its fragment: there is no server-side project database. **HTML export** creates a standalone, animated, read-only diagram with the source embedded. Never put credentials or sensitive plant data in a public share link.

Syntax errors keep the last valid preview visible and block visual changes until the code is fixed. Computed properties such as `x: GRID * 3` are shown read-only in the inspector; the editor does not guess how to invert a formula.

## Local development

Node.js **24 LTS** (exact tested version in `.nvmrc`):

```sh
npm ci
npm run dev
```

Open **http://localhost:4173/scada/**. These commands also work in Windows PowerShell. Restart `npm run dev` after source changes; this intentionally small server has no hot-module reload.

Bun can also run the scripts (`bun run build`, `bun run preview`); CI installs the pinned dependency tree using `package-lock.json` and `npm ci`.

```sh
npm run check                       # build, strict TypeScript, core and 3D contract tests
npx playwright install --with-deps chromium webkit
npm run test:e2e                    # real browser interaction tests
```

For browser runtimes that deliberately disallow HTTP navigation, `SCADA_INJECT=1` injects the same built assets into an opaque-origin Chromium page. It skips the two tests that require an HTTP origin. CI never uses this mode.

The optional equipment lab runs with `npm run lab` on **http://127.0.0.1:4174/**. It demonstrates three procedural 3D components, shared 2D/3D signal state, and a searchable index of 478 P&ID symbol names. It is separate from the editor and uses synthetic data. See the [architecture and harness instructions](docs/3d-foundation.md) and [review evidence](docs/evidence-3d/README.md).

## What is included

Tank, round pump, regulating valve, flanged inline flowmeter, heat exchanger, process outlet, pressure gauge and temperature sensor; quality/alarm states; port-aware obstacle routing; real rotor and rectangular water-flow animations; a sampled flow trend; source-preserving AST edits; code completion, diagnostics, formatting and a shared undo history; file and HTML export; URL sharing; responsive layout; CI and Pages deployment.

This is a **declarative TypeScript subset**, interpreted from the TypeScript AST. It does not execute arbitrary JavaScript. It accepts named imports, `const`, DSL calls, literal property objects and scalar expressions. See the [language contract](docs/dsl.md).

## Simulation boundary

This workbench does not control equipment. The preview uses an explicitly simplified series-circuit model, not hydraulic simulation: one source, one pump, one outlet, no branches. Flow follows signed RPM and valve opening. A closed valve blocks the whole connected circuit; the independently powered rotor can keep spinning. A dry tank or trip blocks flow; uncertain quality makes flow unknown rather than presenting a guessed measurement. Incomplete or unsupported topologies produce diagnostics. Separate circuits are calculated independently.

Pressure, temperature, level and vibration are demonstration samples. There is no fluid conservation, head curve, PLC protocol, PID controller, interlock verification or safety certification. Do not use this preview as an operational control or safety system.

## GitHub Pages

The Pages workflow runs the build, core tests and browser tests before publishing `dist/`. It uploads Playwright reports and screenshots even on failures. Paths are relative, so the build works below `/scada/` as well as on a custom domain.

For forks, select **Settings → Pages → Source → GitHub Actions**, then run **Check and deploy**. The first deployment requires Pages to be enabled by a repository administrator; ordinary workflow tokens may not be permitted to enable a new site.

## Toolchain and updates

The project is checked with TypeScript 7. The browser-side DSL parser uses Microsoft's `@typescript/typescript6` compatibility package for the JavaScript Compiler API. Test/build tools are development dependencies. Dependabot groups monthly npm and Actions updates rather than opening a PR per package.

Parameter and quality changes retain existing SVG nodes and animation phases. Routing is recalculated only when topology, positions or tap placement change. This cache is disposable; the only saved project is still `scene.ts`.

MIT © Roman Popov. See [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).
