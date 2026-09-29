import { defineConfig } from 'vitest/config';

/** The whole-song analysis packages under harmonia/packages, which `npm test` does not collect. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['harmonia/packages/**/*.test.ts'],
  },
});
