# Contributing

Use Node.js 24 LTS (see `.nvmrc`) and `npm ci`. Run `npm run check` and the Chromium/WebKit Playwright suite before sending a PR. The README documents browser installation and the local server.

Changes to visual interactions need tests proving that the TypeScript source changes correctly, survives export/import and undo/redo, and produces the expected browser frame. Include a screenshot from the actual render for geometry or design changes. Do not use generated illustrations as evidence that the renderer works.

Keep authored project persistence source-only; server-run observations and checkpoints belong in the separate run store. AST edits must preserve unrelated source and must refuse to overwrite computed expressions. Never introduce arbitrary user-code execution into the document origin. Add range/quality handling and port geometry alongside new visual elements.

Report unsupported simulation topologies instead of guessing physics. The preview is a design workbench, not a certified operational control system.

Equipment extensions must register metadata, installed behavior, 2D/3D representation and tests through the public hooks described in docs/architecture.md. New types must not add special cases to the compiler or central renderer. Runtime frames must never dispatch editor transactions. Run npm run test:runtime:e2e for end-to-end stream/replay/failure checks.
