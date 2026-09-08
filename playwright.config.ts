import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 30000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {baseURL: 'http://127.0.0.1:4173/scada/', viewport: {width: 1440, height: 900}, screenshot: 'only-on-failure', trace:'retain-on-failure'},
  webServer: {command:'node scripts/serve.mjs',url:'http://127.0.0.1:4173/scada/',reuseExistingServer:!process.env.CI},
  projects: process.env.SCADA_INJECT ? [{name:'chromium',use:{browserName:'chromium',launchOptions:{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}}}] : [{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
});
