# Runtime reliability and developer workflow

## Connection and source editing

Transport activity and fresh telemetry are independent. SSE comments reset the
transport watchdog only. A running model that does not advance its model time
for 2.5 seconds is shown as **Данные устарели** with null/stale signals; commands
are disabled. Fresh advancing frames restore the live display. Duplicate
snapshots and command-only sequence increments do not extend freshness. Terminal
completed/failed runs are exempt; their status is carried in snapshots so a
late subscriber need not have observed the terminal event.

Metadata fields marked `scope: 'layout'` do not affect behavior compatibility.
Built-in coordinates and tap placement, and the installed filter's coordinates,
are marked accordingly. Moving these symbols does not unsubscribe the run.
Behavior/topology changes detach the selected run but keep authentication to the
same server. Temporary syntax errors retain the last valid scene and stream,
block commands and automatically recover when corrected. Explicit destination
changes/disconnects still clear credentials.

Saved pre-v2 configuration hashes are recalculated from their retained source
at load; original source, commands, samples and checkpoints are not rewritten.
The new field-ownership rule is the only identity migration.

## Failure domains

Each running model is stepped in its own error boundary. A model exception
persists a terminal failed frame with unknown/bad signals, publishes a generic
failure event and allows following runs to advance. The failure frame does not
call the broken model again. Shared SQLite failures instead surface as a server
storage failure: streams close, `/api/health` returns 503, and no uncommitted
frame is published. A successful later storage step restores health.

## History and trends

The graph selects the chosen equipment's numeric signal or a selected pipe's
flow; it never silently reads the first circuit's flow. Signal identity and unit
are visible beside the plot and readout.

Raw history reads use an indexed model-time range, sequence cursor and fixed
watermark. The browser defaults to a 60-second window, accepts 1–300 seconds,
retains at most 10,000 frames in a window, and fetches the next window as playback
reaches it. The server continues recording while a client replays its frozen
watermark. A new history load captures a newer watermark.

`GET /api/runs/:id/history` additionally accepts `fromMs`, `toMs` and `untilSeq`.
`GET /api/runs/:id/trend` accepts those bounds, `equipmentId` + `signal` (or
`linkId` + `signal=flow`) and `maxPoints` (4–2000). Its SQL min/max overview is
bounded before reaching the browser. A bucket with unavailable data is shown as
a gap rather than interpolated as a real measurement. Overviews are for visual
navigation; exact replay uses recorded frames. Playback updates the cursor and
readouts without reconstructing the overview path for every frame.

Existing SQLite archives add/backfill `sim_time_ms` once and create the
`frames_time` index. Full frame recording remains deliberately uncompressed and
has no multiyear retention policy. Windowed reads fix browser behavior; they do
not turn this demo recorder into a production historian.

## SDK and completion

The separate `examples/consumer` package imports `@pom4h/scada/core` and
`@pom4h/scada/sdk` without internal relative paths. `defineComponent()` infers
field values, choices, ports, signal types and command arguments from literal
metadata. The consumer test has expected compiler errors for misspelled fields,
wrong values, invalid ports/directions and incorrect command parameters, plus an
executed bundled smoke test. These are source entrypoints for TS-aware bundlers;
the repository is still private-to-npm and no package was published.

The browser's recovery-parser completion reads the same metadata for fields,
units/ranges, enum choices and named ports. Extensions such as the filter get
`resistance` completion without another central list. The editor remains a
bounded declarative language, not a general TS language server.

## Development rebuilds

`npm run dev` now watches source/content changes, builds into a staging directory
and switches only a successful build into `dist`. Invalid edits preserve the
last working assets. A development-only revision endpoint reloads the browser
after a successful build; source autosave survives that reload. This is a
full development reload, not state-preserving component HMR. Production Git
project reload is independent and does not reload the application bundle.

## Reproducible verification

```sh
npm run check
npm run test:e2e
npm run challenge:browser
```

`tests/review.test.ts` covers freshness, independent model/storage errors,
configuration identity, indexed signal-specific history, Git rollback/restart,
CAS saves, unsafe files, authenticated project delivery, pinned runs and
metadata completion. `tests/e2e/runtime-review.spec.ts` covers server files,
browser commits, draft preservation, live-compatible reload, incomplete TS,
selected-signal playback, fixed graph DOM and failed deployments.

Local runtime/SDK tests use the repository's pinned Node 24.20.0. The supplied
Chromium in the editing environment rejects HTTP navigation with
`ERR_BLOCKED_BY_ADMINISTRATOR`; those local browser failures are not reported as
application passes. Actual HTTP browser validation is performed by GitHub CI
with Playwright's browsers. The PR's final check run is the browser evidence.
