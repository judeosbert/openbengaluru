import { defineConfig } from 'vite';

// One config for Vite (dev server + build) and vitest (node environment —
// the DOM-free guarantee: lib logic is tested without jsdom, exactly like
// the retired phase1 vm harness ran it).
export default defineConfig({
  test: {
    environment: 'node',
  },
});
