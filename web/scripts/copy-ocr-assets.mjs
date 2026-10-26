// Copies the Tesseract.js worker, OCR engine and English language data
// out of node_modules into public/ocr/, so the built site serves them
// itself. Nothing is fetched from a CDN at run time.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "ocr");

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "core"), { recursive: true });
mkdirSync(join(target, "lang"), { recursive: true });

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

// Worker script.
cpSync(join(pkgDir("tesseract.js"), "dist", "worker.min.js"), join(target, "worker.min.js"));

// OCR engine: the LSTM-only builds (wasm embedded in the .js), plain, SIMD
// and relaxed-SIMD. Tesseract.js picks the fastest one the browser supports.
const core = pkgDir("tesseract.js-core");
for (const file of readdirSync(core)) {
  if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(file)) {
    cpSync(join(core, file), join(target, "core", file));
  }
}

// English language data.
const lang = join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz");
if (!existsSync(lang)) {
  throw new Error(`Language data not found at ${lang}`);
}
cpSync(lang, join(target, "lang", "eng.traineddata.gz"));

console.log("OCR assets copied to public/ocr/");
