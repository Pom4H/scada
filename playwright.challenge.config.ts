import { defineConfig } from '@playwright/test';
import baseline from './playwright.config';

export default defineConfig({
  ...baseline,
  testDir: './challenges/browser',
  outputDir: 'challenge-results/browser',
  timeout: 30_000,
  expect: { timeout: 1_500 },
  reporter: [['list'], ['json', { outputFile: 'challenge-results/browser.json' }]],
});
