# Source-first architecture

```text
                 keyboard edits
                       ↓
                CodeMirror document (.ts)
                     ↕ transactions
                AST source patcher ← drag / inspector / connections
                       ↓ compile
              validated transient scene
                 ↙                ↘
         port-based routes      demo circuit model
                 ↘                ↙
                   SVG renderer
```

There is no separately persisted node-position JSON. Local storage, file export and shared URLs all serialize the CodeMirror document. The scene is derived data; runtime phases, visual interpolation and camera are explicitly ephemeral. The read-only HTML exporter embeds a compiled snapshot plus its source and has no alternate editable project state.

## Modules

- `core.ts`: typed builder vocabulary, catalog, ports, value ranges and explicitly limited demo simulation. Add a kind here first.
- `source.ts`: TypeScript AST interpreter, semantic diagnostics and precise source edits. It does not run uploaded code. Computed expressions are protected against destructive inverse edits.
- `geometry.ts`: port-aware orthogonal visibility-graph routing with stubs, bend costs, rounded corners, obstacle checks and attached instruments. Bad layout is reported.
- `view.ts`: SVG component anatomy and one animation clock. A round pump uses real circles; rotation uses an explicit local-center SVG transform. Pipe water is a solid stroke to avoid zero-height gradient bounds on horizontal segments.
- `main.ts`: CodeMirror transactions, shared history, inspector, pointer interaction, selection, import/export/share and viewport controls.
- `standalone.ts`: the same renderer in read-only exported HTML.

Visual drag uses the SVG screen matrix to map browser pixels back to scene coordinates. Each gesture opens and closes a shared history group. Source changes compile synchronously, and stale source AST locations are never reused after an edit. Undo acts on source, which regenerates the model and preview.

When source is invalid, the last valid visual frame is retained and visual writes are disabled. CodeMirror diagnostics are scheduled after the update lifecycle. When the source becomes valid again, the preview and inspector reconcile from it.

## Extending

For a new equipment kind: define state/ranges and port geometry in the catalog, implement its SVG anatomy/update in `SceneView`, expose a builder, extend simulation only if a supported physical interpretation exists, and add parser/roundtrip/browser tests. Do not copy x/y into a separately persisted scene store or mutate project state inside an animation callback.

The current renderer derives routes synchronously and limits projects to 48 elements. It is intended for small/medium engineering diagrams; large project language services, automatic equipment placement, real PLC bindings, collaboration and full hydraulic simulation are separate future work.
