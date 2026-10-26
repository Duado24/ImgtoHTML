/** Tesseract.js, running in a Web Worker inside this page. The worker,
 *  engine and English data are served from ./ocr/ next to the page
 *  (copied there at install time), never from a CDN. */

import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import type { OcrWord } from "../core/types";

let worker: Promise<Worker> | undefined;
let onProgress: ((status: string, progress: number) => void) | undefined;

const local = (path: string) => new URL(path, document.baseURI).href;

function getWorker(): Promise<Worker> {
  worker ??= (async () => {
    const w = await createWorker("eng", OEM.LSTM_ONLY, {
      workerPath: local("ocr/worker.min.js"),
      corePath: local("ocr/core"),
      langPath: local("ocr/lang"),
      gzip: true,
      // Don't keep a copy in the browser's IndexedDB; the files are local anyway.
      cacheMethod: "none",
      logger: (m) => onProgress?.(m.status, m.progress),
    });
    // One uniform block of text, same as the Python version's --psm 6.
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    return w;
  })().catch((err: unknown) => {
    worker = undefined; // let the next attempt try again
    throw err;
  });
  return worker;
}

/** Start loading the engine in the background, so the first convert is quicker. */
export function warmUp(): void {
  getWorker().catch(() => {});
}

export async function recognizeWords(
  image: HTMLCanvasElement,
  progress?: (status: string, progress: number) => void,
): Promise<OcrWord[]> {
  onProgress = progress;
  try {
    const w = await getWorker();
    const { data } = await w.recognize(image, {}, { blocks: true });

    const words: OcrWord[] = [];
    (data.blocks ?? []).forEach((block, b) =>
      block.paragraphs.forEach((paragraph, p) =>
        paragraph.lines.forEach((line, l) => {
          for (const word of line.words) {
            words.push({
              text: word.text,
              confidence: word.confidence,
              block: b,
              paragraph: p,
              line: l,
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
            });
          }
        }),
      ),
    );
    return words;
  } finally {
    onProgress = undefined;
  }
}
