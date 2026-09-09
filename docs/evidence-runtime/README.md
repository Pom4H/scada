# Runtime evidence

Actual browser captures and semantic validation for PR #11. All signals are synthetic. See [the verification report](../runtime-validation.md) for commands, environment, before/after measurements, visual review and limitations. `scenario.mp4` is a direct transcode of Playwright's viewport recording; no frames were generated or redrawn.

`capture.json` retains rendered run IDs, sequence numbers, source hashes, observations and assertions. The editor before/after files preserve the same benchmark fixture and methodology. `animation-without-recording.json` measures software WebGL separately from video overhead. Provenance records the implementation commit and dirty working-tree flag because the final UI label/evidence were committed afterward.
