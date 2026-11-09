import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/ and anywhere else.
  base: './',
  plugins: [preact()],
  resolve: {
    alias: {
      '@core/plugin-api': fileURLToPath(new URL('./src/core/plugin-api/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
