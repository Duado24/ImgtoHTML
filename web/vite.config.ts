import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths, so the built folder works from any web address
  // (a course server, GitHub Pages, a shared drive behind a web server).
  base: "./",
  build: {
    outDir: "dist",
    // The OCR files in public/ocr are large on purpose; don't warn about them.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
