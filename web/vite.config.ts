/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on :8787 and Vite proxies /api to it, so the
// browser sees a single origin (cookies, SSE and OAuth redirects just work).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
