import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Serve the project-level /data/processed/ as /data/processed/ in dev
  publicDir: 'public',
  server: {
    fs: {
      // Allow serving files from the project root (for parquet files)
      allow: ['.', '..'],
    },
  },
  // Optimize DuckDB-WASM: exclude from dependency pre-bundling
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
