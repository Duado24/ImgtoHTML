import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { addDiagram, addVision, applyDecisions, convert, previewPage, type ConvertInput, type ConvertResult } from "../src/core/convert";
import type { Diagram } from "../src/core/diagram";
import type { ReviewState } from "../src/core/model";
import type { Box, OcrWord } from "../src/core/types";
import { cropPixels } from "../src/core/preprocess";
import { NullVisionModel, type VisionModel } from "./vision";
import type { Job, JobResult } from "../src/shared/api";
import type { DecodedImage } from "./image";
import type { OcrEngine } from "./ocr/engine";
import { recognizeWords, score } from "./ocr/pipeline";

type Submission = Pick<ConvertInput, "fileName" | "kind" | "label" | "caption" | "transcript" | "editorWindow">;
const TTL = 30 * 60 * 1000;
const MAX_RESULTS = 20;
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
  decisions: Map<string, ReviewState>;
  /** Regions with a word the reviewer changed (approving them records "corrected"). */
  edited: Set<string>;
}

interface Entry {
  job: Job;
  finished?: number;
  session?: Session;
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

  constructor(
    private readonly engine: OcrEngine,
    private readonly vision: VisionModel = new NullVisionModel(),
    /** Where reviewer corrections are appended; null keeps none (tests). */
    private readonly corrections: string | null = CORRECTIONS,
  ) {}

  get(id: string): Job | undefined {
    this.prune();
    return this.entries.get(id)?.job;
  }

  private prune() {
    for (const [id, entry] of this.entries) {
      if (entry.finished !== undefined && Date.now() - entry.finished >= TTL) this.entries.delete(id);
    }
    const finished = [...this.entries].filter(([, entry]) => entry.finished !== undefined);
    for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_RESULTS))) this.entries.delete(id);
  }

  private get usesVision() {
    return !(this.vision instanceof NullVisionModel);
  }

  /** Convert again from the session's words, readings and decisions. */
  private finalize(session: Session): JobResult {
    const { input, image } = session;
    let result: ConvertResult = convert({ ...input, pixels: image.pixels, animated: image.animated, words: session.words });
    if (this.usesVision) {
      const readings = session.readings.flatMap((reading) => {
        const best = result.model.regions.reduce<{ id: string; area: number } | null>((top, r) => {
          const area = overlap(r.box, reading.box);
          return area > (top?.area ?? 0) ? { id: r.id, area } : top;
        }, null);
        return best ? [{ regionId: best.id, role: reading.role, text: reading.text }] : [];
      });
      result = addVision(result, this.vision.name, readings, session.visionError);
    }
    if (session.diagram && !input.transcript?.trim()) result = addDiagram(result, session.diagram);
    result = applyDecisions(result, session.decisions);
    const imageDataUrl = `data:image/png;base64,${image.png.toString("base64")}`;
    return { ...result, imageDataUrl, preview: previewPage(result, imageDataUrl) };
  }

  /** Run work after any queued OCR, showing progress on the job meanwhile. */
  private queue(id: string, entry: Entry, work: (progress: (text: string) => void) => Promise<void>, release?: () => void) {
    this.tail = this.tail.then(async () => {
      // Let the 202 response and any waiting polls flush before doing CPU work.
      await setImmediate();
      const progress = (text: string) => (entry.job = { id, status: "running", progress: text });
      try {
        await work(progress);
        entry.job = { id, status: "completed", result: this.finalize(entry.session!) };
      } catch (error) {
        entry.job = { id, status: "failed", error: message(error) };
      } finally {
        entry.finished = Date.now();
        release?.();
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
    const entry: Entry = { job: { id, status: "queued", progress: "Waiting for the text reader…" } };
    this.entries.set(id, entry);
    this.queue(id, entry, async (progress) => {
      progress("Reading text…");
      const words = await recognizeWords(this.engine, image.pixels, progress);
      const session: Session = { input, image, words, readings: [], decisions: new Map(), edited: new Set() };
      if (this.usesVision) {
        progress("Checking with the vision model…");
        const first = convert({ ...input, pixels: image.pixels, animated: image.animated, words });
        const regions = first.model.regions.filter((r) => r.lines.length).map(({ id, box }) => ({ id, box }));
        try {
          session.readings = await this.readVision(session, regions);
          if (input.kind === "diagram" && this.vision.describeDiagram) {
            progress("Describing the diagram…");
            session.diagram = await this.vision.describeDiagram(image.pixels);
          }
        } catch (error) {
          session.visionError = message(error);
        }
      }
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
    entry.finished = undefined;
    // Show it as running at once, so polling never sees the old result as the new one.
    entry.job = { id, status: "running", progress: "Waiting for the text reader…" };
    this.queue(id, entry, async (progress) => {
      progress(`Reading ${regionId} again…`);
      const before = session.words.filter((w) => centerIn(w, region.box));
      const again = (await recognizeWords(this.engine, cropPixels(pixels, box))).map((w) => ({
        ...w,
        x: w.x + box.x,
        y: w.y + box.y,
        symbols: w.symbols?.map((s) => ({ ...s, x: s.x + box.x, y: s.y + box.y })),
      }));
      if (score(again) > score(before)) {
        session.words = [...session.words.filter((w) => !before.includes(w)), ...again];
      }
      if (this.usesVision) {
        progress(`Asking the vision model about ${regionId}…`);
        try {
          const [reading] = await this.readVision(session, [{ id: regionId, box: region.box }], hint ?? "");
          if (reading) session.readings = [...session.readings.filter((r) => overlap(r.box, region.box) === 0), reading];
          session.visionError = undefined;
        } catch (error) {
          session.visionError = message(error);
        }
      }
      session.decisions.delete(regionId);
    });
  }

  async close() {
    await this.tail;
    await this.engine.close?.();
    this.entries.clear();
  }
}
