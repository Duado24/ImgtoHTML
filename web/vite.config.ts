import { defineConfig } from "vitest/config";

export default defineConfig({
  // OCR workers/data now live only on the server, including older generated assets.
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  build: {
    outDir: "dist",
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
