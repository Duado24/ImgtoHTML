/** Score the converter on the test set in fixtures/ (see fixtures/README.md),
 *  through the same job the app runs: OCR, layout detection, vision
 *  readings, lookalike corrections, rendering.
 *
 *    npm run eval [-- --save-baseline] [-- --only <text>] [-- --refresh-vision] [-- --allow-empty]
 *
 *  The vision model's answers are saved next to each screenshot
 *  (<name>.vision.json) and replayed, so runs repeat exactly; only missing
 *  answers are asked for (all of them with --refresh-vision). Without
 *  Ollama, missing answers are empty and the entry says so.
 *
 *  Exits with 1 when a screenshot's text got worse than the baseline, its
 *  layout matches its marked boxes less well, it shows more made-up words,
 *  or a new Canvas error appeared, so it can guard changes. */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ConvertResult } from "../src/core/convert";
import type { Diagram } from "../src/core/diagram";
import { scoreLayout, scoreText, unsupportedWords, type LayoutScore, type TextScore } from "../src/core/metrics";
import { isKind, type Kind, type Pixels } from "../src/core/types";
import type { RegionReading } from "../src/core/vision";
import type { LayoutDetection } from "../src/core/vision-layout";
import type { JobResult } from "../src/shared/api";
import { decodeImage } from "../server/image";
import { Jobs } from "../server/jobs";
import { LocalOcr } from "../server/ocr";
import { OllamaVisionModel, type VisionModel, type VisionRegion } from "../server/vision";
import { cutOffTokens, withoutCutOffAnnotations } from "./eval-text";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures");
const RESULTS = join(ROOT, "eval-results");
const BASELINE = join(FIXTURES, "baseline.json");
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);
const FOLDER_KINDS: Record<string, Kind> = { ide: "code", ui: "interface", diagrams: "diagram", terminals: "terminal" };
/** Worse by more than this (0.5 percentage points of CER) counts as a regression. */
const TOLERANCE = 0.005;
/** A drop in mean layout overlap larger than this counts as a regression. */
const LAYOUT_TOLERANCE = 0.05;

interface Entry {
  file: string;
  kind: Kind;
  seconds: number;
  lowConfidence: number;
  regions?: number;
  /** Regions the review loop would ask about, and their flags. */
  flaggedRegions?: number;
  flags?: number;
  canvasErrors: string[];
  canvasWarnings: string[];
  text: TextScore | null;
  /** Text scores exclude only explicitly recorded visual cutoff annotations. */
  cutOffAnnotations?: number;
  /** Layouts: the component whose text best matches the .txt (which may cover only the code). */
  textFrom?: string;
  renderer?: string;
  layoutReason?: string | null;
  /** Against <name>.layout.json, when there is one. */
  layout?: LayoutScore | null;
  /** Visible words no OCR word or recorded correction supports; null for diagrams (described in words by design). */
  unsupported?: string[] | null;
  /** Where the vision model's answers came from. */
  vision?: "saved" | "asked" | "missing";
}

const args = process.argv.slice(2);
const saveBaseline = args.includes("--save-baseline");
const refreshVision = args.includes("--refresh-vision");
const only = args[args.indexOf("--only") + 1];
const filter = args.includes("--only") ? only : undefined;

/** The vision model, answering from a screenshot's saved answers and asking
 *  Ollama (`live`, null when it isn't running) only for the rest. */
class SavedVision implements VisionModel {
  readonly name: string;
  changed = false;
  missing = 0;
  constructor(private readonly live: OllamaVisionModel | null, readonly answers: Record<string, unknown>) {
    this.name = live?.name ?? new OllamaVisionModel().name;
  }
  private async answer<T>(key: string, ask: (live: OllamaVisionModel) => Promise<T>, empty: T): Promise<T> {
    if (!refreshVision && key in this.answers) return this.answers[key] as T;
    if (!this.live) {
      this.missing++;
      return empty;
    }
    const value = await ask(this.live);
    this.answers[key] = value;
    this.changed = true;
    return value;
  }
  detectLayout(image: Pixels): Promise<LayoutDetection> {
    return this.answer("layout", (m) => m.detectLayout(image), { layout: null, attempts: [] });
  }
  analyze(image: Pixels, regions: readonly VisionRegion[], focus?: { hint?: string }): Promise<RegionReading[]> {
    const key = `read ${JSON.stringify(regions.map((r) => [r.id, ...Object.values(r.box).map(Math.round)]))} ${focus?.hint ?? ""}`;
    return this.answer(key, (m) => m.analyze(image, regions, focus), []);
  }
  describeDiagram(image: Pixels): Promise<Diagram> {
    return this.answer("diagram", (m) => m.describeDiagram(image), { summary: "", nodes: [], edges: [] });
  }
}

/** Words the page may show: what OCR read (after privacy masking and any
 *  lookalike correction, as the model's spans hold it), plus the caption. */
function supportedWords(result: ConvertResult): string[] {
  return [
    ...result.model.regions.flatMap((r) => r.lines.flatMap((l) => l.spans.map((s) => s.text))),
    ...(result.review.vision?.corrected ?? []).map((c) => c.to),
    ...cutOffTokens(result.review.cut_off_lines),
    result.caption ?? "",
  ];
}

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
  // Screenshots stay local (privacy), so a fresh checkout has none. That is
  // not a pass: say nothing was checked, and fail unless told it's expected.
  const where = `${relative(process.cwd(), FIXTURES)}/${filter ? ` matching "${filter}"` : ""}`;
  if (args.includes("--allow-empty")) {
    console.log(`SKIPPED: no screenshots in ${where}, nothing was checked (--allow-empty). See fixtures/README.md.`);
    process.exit(0);
  }
  console.error(`No screenshots in ${where}, so nothing was checked. See fixtures/README.md, or pass --allow-empty where that's expected.`);
  process.exit(1);
}

await mkdir(join(RESULTS, "preview"), { recursive: true });
const engine = new LocalOcr();
const ollama = new OllamaVisionModel();
const live = (await ollama.available()) ? ollama : null;
if (!live) console.log("Ollama isn't running: screenshots without saved vision answers run without them.");
const entries: Entry[] = [];
// The same screenshot saved twice would count twice in the means: score it once.
const seen = new Map<string, string>();
const duplicates: string[] = [];
try {
  for (const path of files) {
    const file = relative(FIXTURES, path).split(sep).join("/");
    const bytes = await readFile(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(hash)) {
      duplicates.push(`${file} (same as ${seen.get(hash)})`);
      continue;
    }
    seen.set(hash, file);
    const meta = JSON.parse((await sidecar(path, ".json")) ?? "{}") as { kind?: string; label?: string };
    const expected = await sidecar(path, ".txt");
    const marked = await sidecar(path, ".layout.json");
    const saved = await sidecar(path, ".vision.json");
    const kind = kindOf(path, meta);
    const vision = new SavedVision(live, saved ? JSON.parse(saved) : {});
    const started = performance.now();
    const image = await decodeImage(bytes, basename(path));
    // One job per screenshot, exactly as the server runs it.
    const jobs = new Jobs(engine, vision, null);
    const id = jobs.submit({ fileName: basename(path), kind, label: meta.label }, image, () => {});
    let job = jobs.get(id)!;
    while (job.status === "queued" || job.status === "running") {
      await sleep(20);
      job = jobs.get(id)!;
    }
    if (job.status !== "completed") throw new Error(`${file}: ${job.status === "failed" ? job.error : job.status}`);
    const result: JobResult = job.result;
    const seconds = (performance.now() - started) / 1000;
    if (vision.changed) await writeFile(path.slice(0, -extname(path).length) + ".vision.json", JSON.stringify(vision.answers, null, 1));
    await writeFile(join(RESULTS, "preview", file.replace(/\//g, "__") + ".html"), result.preview.content);
    const issues = result.review.canvas_issues;
    // A layout's .txt may cover one component (the code): score the best match.
    const scoreContent = (text: string) => withoutCutOffAnnotations(text, result.review.cut_off_lines);
    let text = expected === null ? null : scoreText(expected, scoreContent(result.transcript));
    let textFrom = "transcript";
    for (const s of expected === null ? [] : result.sections ?? []) {
      const score = scoreText(expected!, scoreContent(s.lines.join("\n")));
      if (score.cerIgnoringSpaces < text!.cerIgnoringSpaces) [text, textFrom] = [score, s.component];
    }
    entries.push({
      file,
      kind,
      seconds: Math.round(seconds * 10) / 10,
      lowConfidence: result.lowConfidenceCount,
      regions: result.model.regions.length,
      flaggedRegions: result.review.regions_to_review.length,
      flags: result.model.regions.reduce((sum, r) => sum + r.flags.length, 0),
      canvasErrors: issues.filter((i) => i.level === "error").map((i) => i.message),
      canvasWarnings: issues.filter((i) => i.level === "warning").map((i) => i.message),
      text,
      cutOffAnnotations: cutOffTokens(result.review.cut_off_lines).length,
      textFrom,
      renderer: result.review.layout_status.renderer,
      layoutReason: result.review.layout_status.reason,
      layout: marked === null ? null : scoreLayout(result.review.layout?.components, JSON.parse(marked).components),
      unsupported: result.review.type === "diagram" ? null : unsupportedWords(result.html, supportedWords(result)),
      vision: vision.missing ? "missing" : vision.changed ? "asked" : "saved",
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
    // Gate on letters, not spacing: expected .txt files often space columns,
    // indent and break lines differently from the screenshot, which makes exact CER noisy.
    const delta = e.text && old?.text ? e.text.cerIgnoringSpaces - old.text.cerIgnoringSpaces : null;
    if (delta !== null && delta > TOLERANCE) {
      regressions.push(`${e.file}: CER ignoring spaces ${pct(old!.text!.cerIgnoringSpaces)} → ${pct(e.text!.cerIgnoringSpaces)}`);
    }
    for (const error of e.canvasErrors) {
      if (old && !old.canvasErrors.includes(error)) regressions.push(`${e.file}: new Canvas error: ${error}`);
    }
    if (e.layout && old?.layout && old.layout.meanIoU - e.layout.meanIoU > LAYOUT_TOLERANCE) {
      regressions.push(`${e.file}: layout overlap ${pct(old.layout.meanIoU)} → ${pct(e.layout.meanIoU)}`);
    }
    if (e.unsupported && old?.unsupported && e.unsupported.length > old.unsupported.length) {
      regressions.push(`${e.file}: made-up words ${old.unsupported.length} → ${e.unsupported.length}: ${e.unsupported.slice(0, 5).join(" ")}`);
    }
    return {
      file: e.file,
      kind: e.kind,
      renderer: e.renderer ?? "-",
      "CER no spaces": e.text ? pct(e.text.cerIgnoringSpaces) : "-",
      "vs base": delta === null ? "" : `${delta > 0 ? "+" : ""}${pct(delta)}`,
      CER: e.text ? pct(e.text.cer) : "-",
      "lines no spaces": e.text ? pct(e.text.lineAccuracyIgnoringSpaces) : "-",
      "lines exact": e.text ? pct(e.text.lineAccuracy) : "-",
      confusable: e.text?.confusable?.length ?? "-",
      "layout": e.layout ? pct(e.layout.meanIoU) : "-",
      "made up": e.unsupported?.length ?? "-",
      vision: e.vision ?? "-",
      "low conf": e.lowConfidence,
      "to review": `${e.flaggedRegions}/${e.regions}`,
      canvas: e.canvasErrors.length ? `${e.canvasErrors.length} errors` : e.canvasWarnings.length ? `${e.canvasWarnings.length} warnings` : "ok",
      sec: e.seconds,
    };
  }),
);

if (duplicates.length) console.log(`Skipped ${duplicates.length} duplicate screenshots: ${duplicates.join(", ")}`);
// Per type: each renderer has its own text, so one mean over all hides which got worse.
const scored = entries.filter((e) => e.text);
for (const kind of [...new Set(scored.map((e) => e.kind))].sort()) {
  const group = scored.filter((e) => e.kind === kind);
  const mean = (f: (t: TextScore) => number) => pct(group.reduce((s, e) => s + f(e.text!), 0) / group.length);
  console.log(
    `Mean over ${group.length} ${kind} with expected text: CER ignoring spaces ${mean((t) => t.cerIgnoringSpaces)}, ` +
      `lines ignoring spaces ${mean((t) => t.lineAccuracyIgnoringSpaces)} (exact: CER ${mean((t) => t.cer)}, lines ${mean((t) => t.lineAccuracy)})`,
  );
}
const unscored = [...new Set(entries.map((e) => e.kind))].filter((k) => !scored.some((e) => e.kind === k));
if (unscored.length) console.log(`No expected text for any ${unscored.sort().join(", ")} screenshot: their text isn't measured.`);
const marked = entries.filter((e) => e.layout);
if (marked.length) console.log(`Layout overlap with marked boxes, mean over ${marked.length}: ${pct(marked.reduce((s, e) => s + e.layout!.meanIoU, 0) / marked.length)}`);
const madeUp = entries.filter((e) => e.unsupported?.length);
console.log(`Made-up words: ${madeUp.reduce((s, e) => s + e.unsupported!.length, 0)} in ${madeUp.length} of ${entries.length} screenshots`);
const annotations = entries.reduce((sum, entry) => sum + (entry.cutOffAnnotations ?? 0), 0);
if (annotations) console.log(`Text scoring excludes ${annotations} recorded cutoff markers (…). The observed text and all other ellipses remain checked.`);
const missing = entries.filter((e) => e.vision === "missing").length;
if (missing) console.log(`${missing} screenshots ran without some vision answers (Ollama off, none saved).`);
await writeFile(join(RESULTS, "latest.json"), JSON.stringify(entries, null, 2));
console.log(`Details: eval-results/latest.json · Previews: eval-results/preview/`);

if (saveBaseline) {
  await writeFile(BASELINE, JSON.stringify(entries, null, 2) + "\n");
  console.log("Saved as the new baseline (fixtures/baseline.json).");
} else if (regressions.length) {
  console.log(`\nWorse than baseline:\n  ${regressions.join("\n  ")}`);
  process.exitCode = 1;
}
