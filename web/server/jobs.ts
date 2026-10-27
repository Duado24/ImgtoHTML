import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { addVision, convert, previewPage, type ConvertInput } from "../src/core/convert";
import { NullVisionModel, type VisionModel } from "./vision";
import type { Job } from "../src/shared/api";
import type { DecodedImage } from "./image";
import type { OcrEngine } from "./ocr/engine";
import { recognizeWords } from "./ocr/pipeline";

type Submission = Pick<ConvertInput, "fileName" | "kind" | "label" | "caption" | "transcript">;
const TTL = 30 * 60 * 1000;
const MAX_RESULTS = 20;

/** One OCR worker at a time, including all panels of a job. Results are
 * ephemeral; restart clears them. Expired results are removed on access. */
export class Jobs {
  private readonly entries = new Map<string, { job: Job; finished?: number }>();
  private tail = Promise.resolve();

  constructor(
    private readonly engine: OcrEngine,
    private readonly vision: VisionModel = new NullVisionModel(),
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

  submit(input: Submission, image: DecodedImage, release: () => void): string {
    this.prune();
    const id = randomUUID();
    const entry: { job: Job; finished?: number } = { job: { id, status: "queued", progress: "Waiting for the text reader…" } };
    this.entries.set(id, entry);
    this.tail = this.tail.then(async () => {
      // Let the 202 response and any waiting polls flush before doing CPU work.
      await setImmediate();
      entry.job = { id, status: "running", progress: "Reading text…" };
      try {
        const words = await recognizeWords(this.engine, image.pixels, (progress) => {
          entry.job = { id, status: "running", progress };
        });
        let result = convert({ ...input, pixels: image.pixels, animated: image.animated, words });
        if (!(this.vision instanceof NullVisionModel)) {
          entry.job = { id, status: "running", progress: "Checking with the vision model…" };
          const regions = result.model.regions.filter((r) => r.lines.length).map(({ id, box }) => ({ id, box }));
          try {
            result = addVision(result, this.vision.name, await this.vision.analyze(image.pixels, regions));
          } catch (error) {
            result = addVision(result, this.vision.name, [], error instanceof Error ? error.message : String(error));
          }
        }
        const imageDataUrl = `data:image/png;base64,${image.png.toString("base64")}`;
        entry.job = { id, status: "completed", result: { ...result, imageDataUrl, preview: previewPage(result, imageDataUrl) } };
      } catch (error) {
        entry.job = { id, status: "failed", error: error instanceof Error ? error.message : String(error) };
      } finally {
        entry.finished = Date.now();
        release();
        this.prune();
      }
    });
    return id;
  }

  async close() {
    await this.tail;
    await this.engine.close?.();
    this.entries.clear();
  }
}
