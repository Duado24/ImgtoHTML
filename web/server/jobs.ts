import { checkCanvasSafe } from "../src/core/canvas";
import type { LayoutDetection } from "../src/core/vision-layout";
import { BUILD_ID } from "./build";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { addDiagram, addVision, applyDecisions, convert, previewPage, type ConvertInput, type ConvertResult } from "../src/core/convert";
import type { Diagram } from "../src/core/diagram";
import { countWordsToCheck, type ReviewState } from "../src/core/model";
import type { Box, OcrWord } from "../src/core/types";
import { cropPixels } from "../src/core/preprocess";
import { lookalikeFixes } from "../src/core/vision";
import { NullVisionModel, type VisionModel } from "./vision";
import type { Job, JobProgress, JobResult, JobStage } from "../src/shared/api";
import type { DecodedImage } from "./image";
import type { OcrEngine } from "./ocr/engine";
import { recognizeWords, score } from "./ocr/pipeline";

type Submission = Pick<ConvertInput, "fileName" | "kind" | "label" | "caption" | "transcript" | "editorWindow">;
const TTL = 30 * 60 * 1000;
const MAX_RESULTS = 20;
const GRACE = 60_000;
const DEFAULT_TIMEOUT = 600_000;
// A stable share for each stage makes OCR's own percentage useful without
// pretending that waiting on the layout/vision model has measurable progress.
const STAGES: Record<JobStage, { start: number; end: number; step: number }> = {
  queued: { start: 0, end: 5, step: 0 },
  "read-text": { start: 5, end: 55, step: 1 },
  "detect-layout": { start: 55, end: 65, step: 2 },
  vision: { start: 65, end: 85, step: 3 },
  render: { start: 85, end: 95, step: 4 },
  validate: { start: 95, end: 99, step: 5 },
};
const QUEUED: JobProgress = { progress: "Waiting for the text reader…", percent: 0, stage: "queued", step: 0, totalSteps: 5 };
type Progress = (stage: JobStage, text: string, fraction?: number) => void;

function positiveSetting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && (name !== "IMGTOHTML_JOB_TIMEOUT_MS" || value <= 2_147_483_647)) return value;
  console.warn(`${name} must be a positive number; using ${fallback}.`);
  return fallback;
}
/** Margin (px) around a region when it is re-read on its own. */
const FOCUS_PAD = 8;
/** Reviewer corrections, one JSON object per line: future training data. Not committed. */
const CORRECTIONS = fileURLToPath(new URL("../corrections/corrections.jsonl", import.meta.url));

export class ReviewError extends Error {}

/** A vision reading, kept by box so it finds its region again after re-reads. */
interface Reading {
  box: Box;
  role: string;
  text: string;
}

/** Everything needed to rebuild a result after a review action. */
interface Session {
  input: Submission;
  image: DecodedImage;
  words: OcrWord[];
  readings: Reading[];
  /** Diagrams: the vision model's parts and connections. */
  diagram?: Diagram;
  visionError?: string;
  layout?: LayoutDetection;
  /** Why no layout was asked for, or how asking failed. */
  layoutNote?: string;
  decisions: Map<string, ReviewState>;
  /** Regions with a word the reviewer changed (approving them records "corrected"). */
  edited: Set<string>;
  /** Checklist membership survives edits and focused re-reads. */
  checklist: Set<string>;
}

interface Entry {
  job: Job;
  finished?: number;
  session?: Session;
  retainedBytes?: number;
  fetched?: boolean;
  oversizedLogged?: boolean;
  operation?: {
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    started: boolean;
    release: () => void;
  };
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const centerIn = (w: Box, b: Box) =>
  w.x + w.width / 2 >= b.x && w.x + w.width / 2 <= b.x + b.width && w.y + w.height / 2 >= b.y && w.y + w.height / 2 <= b.y + b.height;
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One OCR worker at a time, including all panels of a job and every
 * re-read. Results are ephemeral; restart clears them. Expired results are
 * removed on access. */
export class Jobs {
  private readonly entries = new Map<string, Entry>();
  private tail = Promise.resolve();
  private readonly timeout = positiveSetting("IMGTOHTML_JOB_TIMEOUT_MS", DEFAULT_TIMEOUT);
  private readonly budget = positiveSetting("IMGTOHTML_MEMORY_BUDGET_MB", 512) * 1024 * 1024;
  private readonly reaper: ReturnType<typeof setInterval>;

  constructor(
    private readonly engine: OcrEngine,
    private readonly vision: VisionModel = new NullVisionModel(),
    /** Where reviewer corrections are appended; null keeps none (tests). */
    private readonly corrections: string | null = CORRECTIONS,
  ) {
    this.reaper = setInterval(() => this.prune(), 30_000);
    this.reaper.unref();
  }

  get(id: string): Job | undefined {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const job = entry.job;
    if (job.status === "completed") entry.fetched = true;
    this.prune();
    return job;
  }

  cancel(id: string): Job | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.finish(entry, { id, status: "failed", error: "Cancelled" });
    return entry.job;
  }

  private account(entry: Entry) {
    const image = entry.session?.image;
    // Conservative estimate: decoded pixels, compressed PNG, UTF-16 output
    // strings (including base64 previews), and session review/OCR metadata.
    entry.retainedBytes = (image?.pixels.data.byteLength ?? 0) + (image?.png.byteLength ?? 0)
      + Buffer.byteLength(JSON.stringify(entry.job), "utf8") * 2
      + (entry.session ? Buffer.byteLength(JSON.stringify({ ...entry.session, image: undefined }), "utf8") * 2 : 0);
    if (entry.retainedBytes > this.budget && !entry.oversizedLogged) {
      console.warn(`Job ${entry.job.id} retains approximately ${entry.retainedBytes} bytes, exceeding the ${this.budget} byte memory budget; keeping it until fetched or the 60-second grace period ends.`);
      entry.oversizedLogged = true;
    }
  }

  private prune() {
    const finished = [...this.entries].filter(([, e]) => e.finished !== undefined)
      .sort((a, b) => a[1].finished! - b[1].finished!);
    let bytes = finished.reduce((sum, [, e]) => sum + (e.retainedBytes ?? 0), 0);
    let count = finished.length;
    for (const [id, entry] of finished) {
      const age = Date.now() - entry.finished!;
      // An individually oversized result is the sole exception to the grace
      // period: once fetched it no longer needs to remain available.
      const oversizedFetched = entry.fetched && (entry.retainedBytes ?? 0) > this.budget;
      if (age < GRACE && !oversizedFetched) continue;
      if (age >= TTL || bytes > this.budget || count > MAX_RESULTS) {
        this.entries.delete(id);
        bytes -= entry.retainedBytes ?? 0;
        count--;
      }
    }
  }

  private finish(entry: Entry, job: Extract<Job, { status: "completed" | "failed" }>) {
    if (entry.finished !== undefined) return;
    entry.job = job;
    entry.finished = Date.now();
    if (entry.operation) {
      clearTimeout(entry.operation.timer);
      if (!entry.operation.started) entry.operation.release();
    }
    if (job.status === "failed") entry.session = undefined;
    this.account(entry);
    this.prune();
  }

  private check(entry: Entry) {
    if (entry.finished === undefined && entry.operation && Date.now() >= entry.operation.deadline) {
      this.finish(entry, { id: entry.job.id, status: "failed", error: `Timed out after ${this.timeout / 60_000} minutes` });
    }
    if (entry.finished !== undefined) throw new Error("Job already finished");
  }

  private get usesVision() {
    return !(this.vision instanceof NullVisionModel);
  }

  /** Convert again from the session's words, readings and decisions. */
  private finalize(session: Session): JobResult {
    const { input, image } = session;
    const build = (words: OcrWord[]) => {
      let result: ConvertResult = convert({ ...input, pixels: image.pixels, animated: image.animated, words, layout: session.layout?.layout });
      // convert() only knows no layout reached it; say why.
      const status = { ...result.review.layout_status, attempts: session.layout?.attempts ?? [] };
      if (!session.layout?.layout && status.reason === "no layout was detected") {
        const problem = session.layout?.attempts.at(-1)?.problem;
        status.reason = session.layoutNote ?? (problem ? `the model's layout was rejected: ${problem}` : status.reason);
      }
      const review = { ...result.review, layout_status: status, server_build: BUILD_ID };
      result = { ...result, review, reviewFile: { ...result.reviewFile, content: JSON.stringify(review, null, 2) } };
      if (this.usesVision) {
        // Each reading goes to the region it overlaps most. Several readings
        // can share one region (a layout's tabs, breadcrumb and code inside
        // one OCR panel): their text joins top to bottom, and the largest
        // names the region.
        const byRegion = new Map<string, Reading[]>();
        for (const reading of session.readings) {
          const best = result.model.regions.reduce<{ id: string; area: number } | null>((top, r) => {
            const area = overlap(r.box, reading.box);
            return area > (top?.area ?? 0) ? { id: r.id, area } : top;
          }, null);
          if (best) byRegion.set(best.id, [...(byRegion.get(best.id) ?? []), reading]);
        }
        const readings = [...byRegion].map(([regionId, rs]) => ({
          regionId,
          role: rs.reduce((a, b) => (b.box.width * b.box.height > a.box.width * a.box.height ? b : a)).role,
          text: [...rs].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).map((r) => r.text).join("\n"),
        }));
        result = addVision(result, this.vision.name, readings, session.visionError);
      }
      return result;
    };
    let result = build(session.words);
    // Unsure words the vision model read with only lookalike characters
    // changed are taken as fixed: convert again with its reading.
    const fixes = this.usesVision ? lookalikeFixes(result.model) : [];
    if (fixes.length) {
      const corrected = session.words.map((w) => {
        const fix = fixes.find((f) => sameBox(w, f.box));
        return fix ? { ...w, text: fix.to, confidence: 100 } : w;
      });
      result = build(corrected);
      const review = { ...result.review, vision: { ...result.review.vision!, corrected: fixes.map(({ from, to }) => ({ from, to })) } };
      result = { ...result, review, reviewFile: { ...result.reviewFile, content: JSON.stringify(review, null, 2) } };
    }
    if (session.diagram && !input.transcript?.trim()) result = addDiagram(result, session.diagram);
    for (const region of result.model.regions) {
      if (region.flags.length) session.checklist.add(region.id);
      if (session.checklist.has(region.id)) {
        region.reviewRequested = true;
        // Re-reading or fixing a word still leaves the final check to the teacher.
        if (!input.transcript?.trim()) region.review = "pending";
      }
    }
    result = applyDecisions(result, session.decisions);
    result.lowConfidenceCount = countWordsToCheck(result.model);
    result.modelFile = { ...result.modelFile, content: JSON.stringify(result.model, null, 2) };
    const imageDataUrl = `data:image/png;base64,${image.png.toString("base64")}`;
    return { ...result, imageDataUrl, preview: previewPage(result, imageDataUrl) };
  }

  /** Run work after any queued OCR, showing progress on the job meanwhile. */
  private queue(id: string, entry: Entry, work: (progress: Progress, check: () => void) => Promise<void>, release?: () => void) {
    let released = false;
    const releaseOnce = () => { if (!released) { released = true; release?.(); } };
    entry.finished = undefined;
    entry.fetched = false;
    const operation = {
      deadline: Date.now() + this.timeout,
      timer: setTimeout(() => this.finish(entry, { id, status: "failed", error: `Timed out after ${this.timeout / 60_000} minutes` }), this.timeout),
      started: false,
      release: releaseOnce,
    };
    entry.operation = operation;
    operation.timer.unref();
    this.tail = this.tail.then(async () => {
      // Let the 202 response and any waiting polls flush before doing CPU work.
      await setImmediate();
      const check = () => this.check(entry);
      const progress: Progress = (stage, text, fraction = 0) => {
        // Engine loggers can call this asynchronously after cancellation.
        // Leave the terminal result alone; check() enforces the deadline at
        // each work boundary without throwing from a worker's event callback.
        if (entry.finished !== undefined || entry.operation !== operation || Date.now() >= operation.deadline) return;
        const range = STAGES[stage];
        const previous = entry.job.status === "running" || entry.job.status === "queued" ? entry.job.percent : 0;
        const percent = Math.max(previous, Math.round(range.start + (range.end - range.start) * Math.max(0, Math.min(1, fraction))));
        entry.job = { id, status: "running", progress: text, percent, stage, step: range.step, totalSteps: 5 };
      };
      try {
        check();
        operation.started = true;
        await work(progress, check);
        check();
        progress("render", "Building your HTML…");
        await setImmediate();
        check();
        let result = this.finalize(entry.session!);
        check();
        progress("validate", "Checking the HTML…");
        await setImmediate();
        check();
        if (process.env.IMGTOHTML_VALIDATE_LAYOUT === "1" && result.review.layout) {
          progress("validate", "Checking the layout in the browser…");
          try {
            const { validateVisual } = await import("./visual-validation");
            check();
            const session = entry.session!;
            const report = await validateVisual(result.html, session.image.png, result.review.layout, session.image.pixels.width, session.image.pixels.height);
            check();
            result = { ...result, html: report.html, htmlFile: { ...result.htmlFile, content: report.html }, review: { ...result.review,
              canvas_issues: checkCanvasSafe(report.html), visual_validation: { status: report.discrepancies.length ? "failed" : "passed", discrepancies: report.discrepancies, pixelMeanAbsoluteError: report.pixelMeanAbsoluteError, repaired: report.repaired } } };
          } catch (error) {
            check();
            result.review.visual_validation = { status: "unavailable", discrepancies: [], pixelMeanAbsoluteError: null, repaired: false, error: message(error) };
          }
          result.reviewFile = { ...result.reviewFile, content: JSON.stringify(result.review, null, 2) };
          result.preview = previewPage(result, result.imageDataUrl);
        }
        check();
        this.finish(entry, { id, status: "completed", result });
      } catch (error) {
        this.finish(entry, { id, status: "failed", error: Date.now() >= operation.deadline ? `Timed out after ${this.timeout / 60_000} minutes` : message(error) });
      } finally {
        releaseOnce();
        this.prune();
      }
    });
  }

  private async readVision(session: Session, regions: { id: string; box: Box }[], hint?: string): Promise<Reading[]> {
    const boxes = new Map(regions.map((r) => [r.id, r.box]));
    const readings = await this.vision.analyze(session.image.pixels, regions, hint === undefined ? undefined : { hint });
    return readings.map((r) => ({ box: boxes.get(r.regionId)!, role: r.role, text: r.text }));
  }

  submit(input: Submission, image: DecodedImage, release: () => void): string {
    this.prune();
    const id = randomUUID();
    const entry: Entry = { session: { input, image, words: [], readings: [], decisions: new Map(), edited: new Set(), checklist: new Set() }, job: { id, status: "queued", ...QUEUED } };
    this.entries.set(id, entry);
    this.queue(id, entry, async (progress, check) => {
      const session = entry.session!;
      const { input, image } = session;
      progress("read-text", "Reading text…");
      const words = await recognizeWords(this.checkedEngine(check), image.pixels,
        (text, percent) => progress("read-text", text, percent / 100));
      check();
      session.words = words;
      progress("detect-layout", "Finding the layout…");
      if (!this.usesVision) session.layoutNote = "the vision model is off";
      else if (!this.vision.detectLayout) session.layoutNote = `${this.vision.name} doesn't detect layouts`;
      if (this.usesVision) {
        if (this.vision.detectLayout && input.kind !== "diagram" && !input.transcript?.trim()) {
          progress("detect-layout", "Finding the layout…");
          try { session.layout = await this.vision.detectLayout(image.pixels); }
          catch (error) {
            session.visionError = `Layout detection: ${message(error)}`;
            session.layoutNote = `layout detection failed: ${message(error)}`;
          }
        }
        check();
        progress("vision", "Checking the picture…");
        const first = convert({ ...input, pixels: image.pixels, animated: image.animated, words, layout: session.layout?.layout });
        // With a layout, the vision model reads each component that holds
        // text (sidebar, tab bar, breadcrumb, code…) on its own: a tab bar
        // read together with the code below it rarely lines up with OCR's lines.
        const layout = first.review.layout;
        const leaves = layout?.components.filter((c) => !layout.components.some((k) => k.parent === c.id) && words.some((w) => centerIn(w, c.box))) ?? [];
        const regions = leaves.length
          ? leaves.map(({ id, box }) => ({ id: `layout-${id}`, box }))
          : first.model.regions.filter((r) => r.lines.length).map(({ id, box }) => ({ id, box }));
        try {
          session.readings = await this.readVision(session, regions);
          check();
          if (input.kind === "diagram" && this.vision.describeDiagram) {
            progress("vision", "Reading the diagram…", 0.5);
            session.diagram = await this.vision.describeDiagram(image.pixels);
          }
        } catch (error) {
          session.visionError = message(error);
        }
      }
      check();
      entry.session = session;
    }, release);
    return id;
  }

  /** The finished job's session and current result, or a ReviewError. */
  private ready(id: string): { entry: Entry; session: Session; result: JobResult } {
    const entry = this.entries.get(id);
    if (!entry) throw new ReviewError("Job not found or expired. Convert the image again.");
    if (entry.job.status !== "completed" || !entry.session) throw new ReviewError("Wait for the job to finish first.");
    return { entry, session: entry.session, result: entry.job.result };
  }

  /** Approve or skip one region, or skip every region still waiting ("all"). */
  decide(id: string, region: string, state: "approved" | "skipped"): Job {
    const { entry, session, result } = this.ready(id);
    const regions = region === "all" ? result.model.regions.filter((r) => r.review === "pending") : result.model.regions.filter((r) => r.id === region);
    if (!regions.length) throw new ReviewError(`No region ${region}.`);
    for (const r of regions) {
      session.decisions.set(r.id, state === "approved" && session.edited.has(r.id) ? "corrected" : state);
    }
    entry.job = { id, status: "completed", result: this.finalize(session) };
    this.account(entry);
    this.prune();
    return entry.job;
  }

  /** Replace one word's text with the reviewer's (typed, or picked from another reading). */
  async edit(id: string, spanId: string, text: string): Promise<Job> {
    const { entry, session, result } = this.ready(id);
    const region = result.model.regions.find((r) => spanId.startsWith(`${r.id}.`));
    const span = region?.lines.flatMap((l) => l.spans).find((s) => s.id === spanId);
    const index = span ? session.words.findIndex((w) => sameBox(w, span.box)) : -1;
    const clean = text.trim();
    if (!region || !span || index < 0) throw new ReviewError(`No word ${spanId}.`);
    if (!clean || /\s/.test(clean)) throw new ReviewError("Enter one word, without spaces.");

    const { symbols: _drop, ...word } = session.words[index]!;
    session.words[index] = { ...word, text: clean, confidence: 100 };
    session.edited.add(region.id);
    entry.job = { id, status: "completed", result: this.finalize(session) };
    this.account(entry);
    this.prune();

    // Saved for later training; a failed write must not lose the edit.
    const record = {
      time: new Date().toISOString(),
      file: session.input.fileName,
      kind: session.input.kind,
      span: spanId,
      box: span.box,
      ocr: span.text,
      alternatives: span.alternatives,
      user: clean,
    };
    if (this.corrections) {
      try {
        await mkdir(dirname(this.corrections), { recursive: true });
        await appendFile(this.corrections, JSON.stringify(record) + "\n");
      } catch {}
    }
    return entry.job;
  }

  /** "This doesn't look right": read one region again on its own, enlarged,
   *  with OCR and the vision model (given the reviewer's hint). */
  retry(id: string, regionId: string, hint?: string): void {
    const { entry, session, result } = this.ready(id);
    const region = result.model.regions.find((r) => r.id === regionId);
    if (!region) throw new ReviewError(`No region ${regionId}.`);
    const { pixels } = session.image;
    const box: Box = {
      x: Math.max(0, region.box.x - FOCUS_PAD),
      y: Math.max(0, region.box.y - FOCUS_PAD),
      width: Math.min(pixels.width, region.box.x + region.box.width + FOCUS_PAD) - Math.max(0, region.box.x - FOCUS_PAD),
      height: Math.min(pixels.height, region.box.y + region.box.height + FOCUS_PAD) - Math.max(0, region.box.y - FOCUS_PAD),
    };
    const regionBox = { ...region.box };
    entry.finished = undefined;
    // Show it as running at once, so polling never sees the old result as the new one.
    entry.job = { id, status: "running", ...QUEUED };
    this.queue(id, entry, async (progress, check) => {
      const session = entry.session!;
      const pixels = session.image.pixels;
      progress("read-text", "Reading this part again…");
      const before = session.words.filter((w) => centerIn(w, regionBox));
      const again = (await recognizeWords(this.checkedEngine(check), cropPixels(pixels, box),
        (text, percent) => progress("read-text", text, percent / 100))).map((w) => ({
        ...w,
        x: w.x + box.x,
        y: w.y + box.y,
        symbols: w.symbols?.map((s) => ({ ...s, x: s.x + box.x, y: s.y + box.y })),
      }));
      check();
      if (score(again) > score(before)) {
        session.words = [...session.words.filter((w) => !before.includes(w)), ...again];
      }
      progress("detect-layout", "Finding this part in the picture…");
      if (this.usesVision) {
        progress("vision", "Checking this part of the picture…");
        try {
          const [reading] = await this.readVision(session, [{ id: regionId, box: regionBox }], hint ?? "");
          check();
          if (reading) session.readings = [...session.readings.filter((r) => overlap(r.box, regionBox) === 0), reading];
          session.visionError = undefined;
        } catch (error) {
          session.visionError = message(error);
        }
      }
      check();
      session.decisions.delete(regionId);
    });
  }

  private checkedEngine(check: () => void): OcrEngine {
    // OCR and Ollama calls may not be interruptible. Keep the serial worker
    // occupied until they settle, stop at the next boundary, discard late
    // results, and release admission exactly once when the work unwinds.
    return { recognize: async (input, progress) => {
      check();
      const words = await this.engine.recognize(input, progress);
      check();
      return words;
    } };
  }

  async close() {
    clearInterval(this.reaper);
    for (const entry of this.entries.values()) this.cancel(entry.job.id);
    await this.tail;
    await this.engine.close?.();
    this.entries.clear();
  }
}
