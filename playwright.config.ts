import { defineConfig, devices } from '@playwright/test'

const viewports = [
  ['desktop-concept', { width: 1536, height: 1024 }],
  ['portrait-concept', { width: 1024, height: 1536 }],
  ['desktop-wide', { width: 1440, height: 900 }],
  ['tablet', { width: 768, height: 1024 }],
  ['mobile', { width: 390, height: 844 }],
] as const

export default defineConfig({
  testDir: './tests/browser',
  timeout: 45_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: viewports.map(([name, viewport]) => ({ name, use: { viewport } })),
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
