import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located with the source, the way the plane was written.
    include: ['src/**/*.test.ts'],
  },
});
