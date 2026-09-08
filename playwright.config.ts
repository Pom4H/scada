import { defineConfig } from '@playwright/test';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
export default defineConfig({
  testDir: './tests/e2e', testIgnore: 'runtime*.spec.ts', timeout: 30000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173/scada/', viewport: { width: 1440, height: 900 },
    reducedMotion: 'no-preference', screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: { command: 'node scripts/serve.mjs', url: 'http://127.0.0.1:4173/scada/', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', ...(executablePath ? { launchOptions: { executablePath } } : {}) } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
