/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on :8787 (or $PORT) and Vite proxies /api to it,
// so the browser sees a single origin (cookies, SSE and OAuth redirects just work).
const apiPort = process.env.PORT || "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
