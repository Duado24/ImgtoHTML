import { defineConfig, type Plugin } from "vitest/config";

/** The built page may load only its own files and may not send anything
 *  anywhere (connect-src 'none'): reports and screenshots' text stay in the
 *  browser. A <meta> policy, because static hosts like GitHub Pages can't
 *  send headers. Inline style attributes stay allowed: the converted HTML,
 *  shown in the preview frame, is made of them. Dev builds skip it, since
 *  Vite's live reload needs a connection. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`),
});

export default defineConfig({
  // Relative paths, so the built folder works from any address (GitHub Pages
  // serves it from /<repository>/, Canvas can embed that page).
  base: "./",
  publicDir: false,
  plugins: [contentSecurityPolicy()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
