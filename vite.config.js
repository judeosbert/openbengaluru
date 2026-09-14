import { defineConfig } from 'vite';

// One config for Vite (dev server + build) and vitest (node environment —
// the DOM-free guarantee: lib logic is tested without jsdom, exactly like
// the retired phase1 vm harness ran it).
export default defineConfig({
  test: {
    environment: 'node',
    /* db_uploads truncates the shared Postgres test db while the endpoint
     * suite holds live rows — serialize test FILES so the suites never
     * interleave their DB state. */
    fileParallelism: false,
  },
  /* Dev only: forward /api/* to the player server (server.js) so wizard
   * submits run the real SUMO pipeline from the vite origin. tools/dev_all.js
   * sets SIMO_API_PORT when 8787 is busy; standalone `npm start` is
   * unchanged. */
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:' + (process.env.SIMO_API_PORT || '8787'),
    },
  },
});
