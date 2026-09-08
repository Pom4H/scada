# Contributing

Use Node.js 22+ and `npm ci`. Run `npm run check` and the Chromium/WebKit Playwright suite before sending a PR. The README documents browser installation and the local server.

Changes to visual interactions need tests proving that the TypeScript source changes correctly, survives export/import and undo/redo, and produces the expected browser frame. Include a screenshot from the actual render for geometry or design changes. Do not use generated illustrations as evidence that the renderer works.

Keep project persistence source-only. AST edits must preserve unrelated source and must refuse to overwrite computed expressions. Never introduce arbitrary user-code execution into the document origin. Add range/quality handling and port geometry alongside new visual elements.

Report unsupported simulation topologies instead of guessing physics. The preview is a design workbench, not a certified operational control system.
