import { defineConfig, devices } from '@playwright/test';

/* Vite serves this app on GSV_DEV_PORT (1420 by default, see vite.config.ts), not Vite's own 5173. */
const PORT = Number(process.env.GSV_DEV_PORT ?? 1420);
const URL = `http://127.0.0.1:${PORT}`;
/* CI runs real Chrome. A dev box that has no Chrome installed (Linux, typically) can run the
   same suite against Playwright's bundled build with PW_CHANNEL=chromium. */
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: URL, ...devices['Desktop Chrome'], ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }), viewport: { width: 1440, height: 960 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: URL, reuseExistingServer: true },
});
