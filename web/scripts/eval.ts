/** Score the converter on the test set in fixtures/ (see fixtures/README.md).
 *
 *    npm run eval [-- --save-baseline] [-- --only <text>]
 *
 *  Exits with 1 when a screenshot's text got worse than the baseline or a
 *  new Canvas error appeared, so it can guard changes. */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { convert, previewPage } from "../src/core/convert";
import { scoreText, type TextScore } from "../src/core/metrics";
import { isKind, type Kind } from "../src/core/types";
import { decodeImage } from "../server/image";
import { LocalOcr } from "../server/ocr";
import { recognizeWords } from "../server/ocr/pipeline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures");
const RESULTS = join(ROOT, "eval-results");
const BASELINE = join(FIXTURES, "baseline.json");
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
const FOLDER_KINDS: Record<string, Kind> = { ide: "code", ui: "interface", diagrams: "diagram", terminals: "terminal" };
/** Worse by more than this (0.5 percentage points of CER) counts as a regression. */
const TOLERANCE = 0.005;

interface Entry {
  file: string;
  kind: Kind;
  seconds: number;
  lowConfidence: number;
  canvasErrors: string[];
  canvasWarnings: string[];
  text: TextScore | null;
}

const args = process.argv.slice(2);
const saveBaseline = args.includes("--save-baseline");
const only = args[args.indexOf("--only") + 1];
const filter = args.includes("--only") ? only : undefined;

async function images(dir: string): Promise<string[]> {
  const found = await readdir(dir, { recursive: true, withFileTypes: true });
  return found
    .filter((d) => d.isFile() && IMAGES.has(extname(d.name).toLowerCase()))
    .map((d) => join(d.parentPath, d.name))
    .filter((f) => !filter || basename(f).includes(filter))
    .sort();
}

async function sidecar(image: string, ext: string): Promise<string | null> {
  const path = image.slice(0, -extname(image).length) + ext;
  return existsSync(path) ? readFile(path, "utf8") : null;
}

function kindOf(file: string, meta: { kind?: string }): Kind {
  if (meta.kind && isKind(meta.kind)) return meta.kind;
  const folder = relative(FIXTURES, file).split(sep)[0]?.toLowerCase() ?? "";
  return isKind(folder) ? folder : FOLDER_KINDS[folder] ?? "terminal";
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const files = await images(FIXTURES);
if (!files.length) {
  console.log(`No screenshots in ${relative(process.cwd(), FIXTURES)}/. See fixtures/README.md.`);
  process.exit(0);
}

await mkdir(join(RESULTS, "preview"), { recursive: true });
const engine = new LocalOcr();
const entries: Entry[] = [];
try {
  for (const path of files) {
    const file = relative(FIXTURES, path).split(sep).join("/");
    const meta = JSON.parse((await sidecar(path, ".json")) ?? "{}") as { kind?: string; label?: string };
    const expected = await sidecar(path, ".txt");
    const kind = kindOf(path, meta);
    const started = performance.now();
    const image = await decodeImage(await readFile(path), basename(path));
    const words = await recognizeWords(engine, image.pixels);
    const result = convert({ fileName: basename(path), pixels: image.pixels, animated: image.animated, words, kind, label: meta.label });
    const seconds = (performance.now() - started) / 1000;
    const preview = previewPage(result, `data:image/png;base64,${image.png.toString("base64")}`);
    await writeFile(join(RESULTS, "preview", file.replace(/\//g, "__") + ".html"), preview.content);
    const issues = result.review.canvas_issues;
    entries.push({
      file,
      kind,
      seconds: Math.round(seconds * 10) / 10,
      lowConfidence: result.lowConfidenceCount,
      canvasErrors: issues.filter((i) => i.level === "error").map((i) => i.message),
      canvasWarnings: issues.filter((i) => i.level === "warning").map((i) => i.message),
      text: expected === null ? null : scoreText(expected, result.transcript),
    });
    process.stdout.write(".");
  }
} finally {
  await engine.close();
}
console.log("\n");

const baseline: Entry[] = !saveBaseline && existsSync(BASELINE) ? JSON.parse(await readFile(BASELINE, "utf8")) : [];
const before = new Map(baseline.map((e) => [e.file, e]));
const regressions: string[] = [];

console.table(
  entries.map((e) => {
    const old = before.get(e.file);
    // Gate on letters, not spacing: expected .txt files often space columns
    // differently from the screenshot, which makes exact CER noisy.
    const delta = e.text && old?.text ? e.text.cerIgnoringSpaces - old.text.cerIgnoringSpaces : null;
    if (delta !== null && delta > TOLERANCE) {
      regressions.push(`${e.file}: CER ignoring spaces ${pct(old!.text!.cerIgnoringSpaces)} → ${pct(e.text!.cerIgnoringSpaces)}`);
    }
    for (const error of e.canvasErrors) {
      if (old && !old.canvasErrors.includes(error)) regressions.push(`${e.file}: new Canvas error: ${error}`);
    }
    return {
      file: e.file,
      kind: e.kind,
      "CER no spaces": e.text ? pct(e.text.cerIgnoringSpaces) : "-",
      "vs base": delta === null ? "" : `${delta > 0 ? "+" : ""}${pct(delta)}`,
      CER: e.text ? pct(e.text.cer) : "-",
      "lines exact": e.text ? pct(e.text.lineAccuracy) : "-",
      confusable: e.text?.confusable?.length ?? "-",
      "low conf": e.lowConfidence,
      canvas: e.canvasErrors.length ? `${e.canvasErrors.length} errors` : e.canvasWarnings.length ? `${e.canvasWarnings.length} warnings` : "ok",
      sec: e.seconds,
    };
  }),
);

const scored = entries.filter((e) => e.text);
if (scored.length) {
  const mean = (f: (t: TextScore) => number) => pct(scored.reduce((s, e) => s + f(e.text!), 0) / scored.length);
  console.log(`Mean over ${scored.length} with expected text: CER ${mean((t) => t.cer)}, ignoring spaces ${mean((t) => t.cerIgnoringSpaces)}, lines exact ${mean((t) => t.lineAccuracy)}`);
}
await writeFile(join(RESULTS, "latest.json"), JSON.stringify(entries, null, 2));
console.log(`Details: eval-results/latest.json · Previews: eval-results/preview/`);

if (saveBaseline) {
  await writeFile(BASELINE, JSON.stringify(entries, null, 2) + "\n");
  console.log("Saved as the new baseline (fixtures/baseline.json).");
} else if (regressions.length) {
  console.log(`\nWorse than baseline:\n  ${regressions.join("\n  ")}`);
  process.exitCode = 1;
}
