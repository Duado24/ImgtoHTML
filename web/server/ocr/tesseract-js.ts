import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import type { OcrWord } from "../../src/core/types";
import type { OcrEngine, OcrImage } from "./engine";

const require = createRequire(import.meta.url);

/** Node worker + WASM + installed English data. No CDN, downloads or cache. */
export class TesseractJs implements OcrEngine {
  private worker?: Promise<Worker>;
  private progress?: (percent: number) => void;

  private getWorker(): Promise<Worker> {
    this.worker ??= (async () => {
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        langPath: join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int"),
        gzip: true,
        cacheMethod: "none",
        // Suppress Tesseract.js's default asynchronous throw; the job promise
        // receives initialization/recognition errors and reports them instead.
        errorHandler: () => {},
        logger: ({ status, progress }) => {
          if (status === "recognizing text" && Number.isFinite(progress)) this.progress?.(progress * 100);
        },
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      return worker;
    })().catch((error: unknown) => { this.worker = undefined; throw error; });
    return this.worker;
  }

  async recognize(image: OcrImage, progress?: (percent: number) => void): Promise<OcrWord[]> {
    this.progress = progress;
    try {
      const worker = await this.getWorker();
      const { data } = await worker.recognize(image.png, {}, { blocks: true });
      const box = (b: { x0: number; y0: number; x1: number; y1: number }) => ({
        x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0,
      });
      const words: OcrWord[] = [];
      (data.blocks ?? []).forEach((block, b) => block.paragraphs.forEach((paragraph, p) =>
        paragraph.lines.forEach((line, l) => {
          for (const word of line.words) words.push({
            text: word.text, confidence: word.confidence, block: b, paragraph: p, line: l, ...box(word.bbox),
            symbols: word.symbols.map((s) => ({ text: s.text, ...box(s.bbox) })),
          });
        }),
      ));
      return words;
    } finally {
      this.progress = undefined;
    }
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await (await worker)?.terminate();
  }
}
