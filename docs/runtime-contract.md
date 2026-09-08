# Runtime contract v1

The authored source, active run, equipment facts, sensor observations, commands and hidden model state are separate objects. Protocol types live in `src/runtime/protocol.ts`. Coordinates and properties in the source are never updated by incoming signals.

## HTTP and authorization

One Node HTTP application binds to 127.0.0.1:4175 by default and serves the built editor and `/api`. Native `node:sqlite` provides transactional storage. Browser credentials remain in memory, entered separately from source and links. All API requests use `Authorization: Bearer ...`; SSE uses fetch streaming so no token enters a URL. Only explicitly configured browser origins are accepted cross-origin.

- View token: public run summaries, snapshots, events, history and replay.
- Operator token: view access plus run creation and installed equipment commands.
- Research token: operator access plus run manifest and hidden model state.

`GET /api/health` is public and does not disclose tokens. `GET /api/runs?projectId=...` returns `{runs: RunSummary[]}`. `POST /api/runs` accepts `CreateRun` and returns `{run: RunSummary, snapshot: RuntimeFrame}`. `GET /api/runs/:id` returns `{run: RunSummary, snapshot: RuntimeFrame}`.

`GET /api/runs/:id/events?after=N` streams SSE events named `frame`, with `id: seq`. Initial/recovery messages are complete snapshots. Every update is also complete, allowing recovery without a second patch protocol. Within one run sequences are strictly increasing and durable across process restart. A client rejects other run IDs and duplicate/old updates. A snapshot establishes a new baseline; a sequence gap triggers resubscription. A disconnected client displays offline/unknown, never confirmed zero.

`POST /api/runs/:id/commands` accepts `EquipmentCommand` and returns `CommandReceipt`. `POST /api/runs/:id/complete` is an idempotent operator action returning `{run, snapshot}` and durably ending recording. New commands are rejected afterward; earlier accepted receipts remain repeatable. A repeated commandId with the same payload returns the original receipt and does not reapply the command. Reusing it for another payload is an error. Unknown installed types/commands and invalid values are rejected server-side. Source parsing performs no I/O and executes no user functions.

`GET /api/runs/:id/history?after=N&limit=500` returns `HistoryPage`, in sequence order. `GET /api/runs/:id/replay?seq=N` returns an exact saved `RuntimeFrame` marked snapshot. `GET /api/runs/:id/research` returns the versioned manifest and current hidden state only to the research role. Public history and telemetry omit the hidden failure cause and scenario field. Public labels default to neutral run names; researchers must exclude any manually supplied revealing labels or project names from blind diagnostic inputs.

## Time, persistence and behavior

The server has a fixed simulation step of 100 ms. `simTimeMs` is elapsed model time; `timestamp` is the run epoch plus model time, so runs with identical epoch, source, seed and commands are reproducible. `createdAt` describes the run's wall-clock creation. Browser visual pause, replay and tab closure have no effect on execution.

Each step atomically stores its public frame and private restart checkpoint. Source, source hash/configuration version, installed behavior versions, initial conditions, seed, commands and events are persisted. A restart resumes the last committed step; the first implementation does not catch up wall time while the server was stopped. Sensor history is synthetic and labeled as such. There is no statistical training or physical hydraulic solver.

Each behavior is registered by kind in an installed server registry. It owns mode transitions, delays, wear and its outputs. Installation rules propagate outputs through declared connections; the central scheduler contains no pump-specific failure logic. A stable equipment position ID maps to an installed instance ID. Service restores an instance after a maintenance delay; replacement installs another instance on the same position.

## Source and representations

The existing `@scada/core` factories remain valid. `runtime({server, project, run?})` is optional declarative metadata. It cannot contain credentials. `component(type, id, properties)` instantiates an installed metadata definition without a new compiler case. Both SVG and 3D use the same `RuntimeFrame`; `setRuntime(null)` selects the legacy local preview. Three.js is dynamically imported only when 3D is selected.

## Ownership during this implementation

- Root: protocol, core/component metadata, compiler/AST edits, main UI orchestration, connection/history client, HTML, build/package/CI, documentation and integration.
- Server engineer: `server/**`, `src/components/filter/behavior.ts`, `tests/server-model.test.ts`; server installed behavior composition.
- Designer: `src/view.ts`, `src/view3d.ts`, `src/style.css`, `src/visual-components.ts`, `src/components/filter/visual.ts`, `lab3d/models.ts`; representation hooks and visual review.
- Independent QA: `tests/runtime-contract.test.ts`, `tests/e2e/runtime*.spec.ts`, `scripts/runtime-qa*.mjs`, `playwright.runtime.config.ts`; independent acceptance and evidence. Production defects return to their owners.

Agents do not commit or modify another owner's files. Root integrates all changes in one feature branch and PR.
