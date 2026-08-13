import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      deny: ["**/src-tauri/target/**"],
    },
  },
  optimizeDeps: {
    // Limit dep-scan to only the app's entry point. Prevents Vite from
    // crawling src-tauri/target/doc (18K+ Rust doc HTML files → EMFILE).
    entries: ["index.html"],
  },
  worker: {
    format: "es",
  },
  build: {
    sourcemap: false,
  },
}));
