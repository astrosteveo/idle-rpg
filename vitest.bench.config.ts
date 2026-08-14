import { defineConfig } from 'vitest/config'

/** Benchmarks live outside the unit suite: they print numbers, they never fail a build. */
export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts'],
    environment: 'node',
    silent: false,
  },
})
