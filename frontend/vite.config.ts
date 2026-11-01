// Owner: B (Frontend)
// Purpose: Vite dev server, build, and Vitest config
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The frontend only ever calls /api; in dev Vite forwards it to the Express backend
    // (PORT in the root .env.example), so the session cookie stays same-origin.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  test: {
    // Logic tests run in Node; component tests opt into a browser-like DOM with a
    // `// @vitest-environment jsdom` line at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
