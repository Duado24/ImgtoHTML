import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Identifies the code this process is running: the first 12 hex digits of
 *  the bundle's SHA-256, as `sha256sum dist-server/index.js` prints it, so
 *  start.sh can tell a server left running from an older build. Read once at
 *  startup; rebuilding the file later doesn't change a running server.
 *  Unbundled (tsx), this module is its own file: "dev". */
const file = fileURLToPath(import.meta.url);
export const BUILD_ID = file.endsWith(".ts") ? "dev" : createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
export const STARTED = new Date().toISOString();
