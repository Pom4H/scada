# SCADA challenge

Reproducible adversarial checks against the playground's documented limits.
The production implementation is unchanged. Assertions describe the desired
behavior; the recorded defects fail normally, without skips or expected-failure
annotations. Keep this suite separate from the existing release gate until the
findings have been resolved.

Read the [findings and measurements](../docs/challenge-2026-09-08.md).

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm run challenge          # core, browser, benchmark; continues after failures
```

Run an individual part:

```sh
npm run challenge:core
npm run challenge:browser
npm run challenge:bench
```

For Chromium only:

```sh
npm run build
npx playwright test --config=playwright.challenge.config.ts --project=chromium
```

The existing `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override also applies to
the challenge. The measured snapshot used headless Chromium 149.0.7827.0
from `@sparticuz/chromium@149.0.0` because the Playwright browser CDN was
unavailable in the execution environment. WebKit was not measured locally.

Outputs go to ignored `challenge-results/`: core TAP, Playwright JSON,
screenshots and traces, generated 8/16/32/48-element `.ts` fixtures, and raw
benchmark samples. Selected evidence is checked into `docs/challenge-evidence/`.

The benchmark has a fixed seed, non-overlapping equipment and a complete series
circuit. It deliberately forces long obstacle-avoiding routes. It measures
synchronous work on a shared machine; it is neither a device FPS rating nor a
claim about every diagram with the same element count. Browser timing uses a
fresh page with native `performance.now`; animation tests use a controlled clock.

On the inspected implementation, the expected result is **6 failing core checks
and 4 failing Chromium checks**. Two browser failures reproduce core failures:
there are eight distinct correctness/contract findings, plus a routing latency
finding. A future run turning green should mean the corresponding behavior was
fixed, not that assertions were weakened.
