/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

// Dev sandbox pages live in /dev/*.html (served automatically by the dev server).
// They are excluded from production builds unless DEV_PAGES=1.
const devPages: Record<string, string> = {};
if (process.env.DEV_PAGES === '1' && existsSync(resolve(import.meta.dirname, 'dev'))) {
  for (const f of readdirSync(resolve(import.meta.dirname, 'dev'))) {
    if (f.endsWith('.html')) devPages[f.replace('.html', '')] = resolve(import.meta.dirname, 'dev', f);
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4500, // the Rapier chunk embeds its WASM (~4.3 MB, 1.7 MB gzip)
    rolldownOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), ...devPages },
      output: {
        // long-lived vendor chunks cache across game updates (Rapier embeds its WASM)
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge/ },
            { name: 'three', test: /node_modules[\\/](three|postprocessing|n8ao|@react-three|three-stdlib|three-mesh-bvh|troika-[^\\/]+|camera-controls|maath|meshline|stats-gl|detect-gpu|hls\.js)[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store|its-fine|suspend-react)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
});
