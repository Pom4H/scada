import { defineConfig } from '@playwright/test';

const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'runtime*.spec.ts',timeout:45000,expect:{timeout:8000},workers:1,fullyParallel:false,
  reporter:[['list'],['html',{outputFolder:'runtime-playwright-report',open:'never'}]],
  outputDir:'runtime-test-results',
  use:{baseURL:'http://127.0.0.1:4188/scada/',viewport:{width:1440,height:900},reducedMotion:'no-preference',trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node scripts/runtime-qa-server.mjs',url:'http://127.0.0.1:4188/api/health',reuseExistingServer:false,timeout:30000},
  projects:[{name:'chromium',use:{browserName:'chromium',launchOptions:{args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'],...(executablePath?{executablePath}:{})}}}],
});
