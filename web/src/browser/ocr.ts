/** Tesseract.js, running in a Web Worker inside this page. The worker,
 *  engine and English data are served from ./ocr/ next to the page
 *  (copied there at install time), never from a CDN. */

import { createWorker, OEM, PSM, type Bbox, type Worker } from "tesseract.js";
import { dominantColor } from "../core/colors";
import { cropPixels, inkImage, ocrScale } from "../core/preprocess";
import { segment, type Leaf, type Region } from "../core/regions";
import type { Box, OcrWord, Pixels, RGB } from "../core/types";

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

/** White margin (in original pixels) around a panel when it is read on
 *  its own; Tesseract misreads text that touches the image edge. */
const PAD = 8;

/** The image Tesseract actually reads: background white, text dark,
 *  enlarged, with a white margin (see core/preprocess.ts). */
function ocrCanvas(pixels: Pixels, background: RGB): { canvas: HTMLCanvasElement; scale: number } {
  const ink = inkImage(pixels, background);
  const small = document.createElement("canvas");
  small.width = ink.width;
  small.height = ink.height;
  small.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(ink.data), ink.width, ink.height), 0, 0);

  const scale = ocrScale(ink.width + 2 * PAD, ink.height + 2 * PAD);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((ink.width + 2 * PAD) * scale);
  canvas.height = Math.round((ink.height + 2 * PAD) * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, PAD * scale, PAD * scale, ink.width * scale, ink.height * scale);
  return { canvas, scale };
}

/** OCR one image (or panel). `origin` is where it sits in the screenshot;
 *  `blockBase` keeps block numbers of different panels apart. */
async function readArea(w: Worker, pixels: Pixels, background: RGB, origin: Box, blockBase: number): Promise<OcrWord[]> {
  const { canvas, scale } = ocrCanvas(pixels, background);
  const { data } = await w.recognize(canvas, {}, { blocks: true });

  // Boxes back to screenshot pixels.
  const box = (b: Bbox): Box => ({
    x: Math.round(b.x0 / scale) - PAD + origin.x,
    y: Math.round(b.y0 / scale) - PAD + origin.y,
    width: Math.max(1, Math.round((b.x1 - b.x0) / scale)),
    height: Math.max(1, Math.round((b.y1 - b.y0) / scale)),
  });

  const words: OcrWord[] = [];
  (data.blocks ?? []).forEach((block, b) =>
    block.paragraphs.forEach((paragraph, p) =>
      paragraph.lines.forEach((line, l) => {
        for (const word of line.words) {
          words.push({
            text: word.text,
            confidence: word.confidence,
            block: blockBase + b,
            paragraph: p,
            line: l,
            ...box(word.bbox),
            symbols: word.symbols.map((s) => ({ text: s.text, ...box(s.bbox) })),
          });
        }
      }),
    ),
  );
  return words;
}

const leaves = (r: Region): Leaf[] => (r.kind === "leaf" ? [r] : r.children.flatMap(leaves));

/** How much readable text a set of words holds: confidence × letters.
 *  Junk ("~~", "]") counts for nothing. */
const score = (words: readonly OcrWord[]) =>
  words.reduce((sum, w) => sum + Math.max(0, w.confidence) * (w.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);

/** Two passes: read the whole screenshot, find its panels, then read each
 *  panel on its own against its own background. Per panel, Tesseract
 *  sees one uniform block and no borders or neighbouring text, which
 *  often fixes misreads; but sometimes it drops a word the first pass
 *  had. So each panel keeps whichever reading scores higher. */
export async function recognizeWords(
  pixels: Pixels,
  progress?: (status: string, progress: number) => void,
): Promise<OcrWord[]> {
  onProgress = progress;
  try {
    const w = await getWorker();
    const whole = { x: 0, y: 0, width: pixels.width, height: pixels.height };
    const first = await readArea(w, pixels, dominantColor(pixels), whole, 0);

    const panels = leaves(segment(pixels, first)).filter((leaf) => leaf.words.length > 0);
    if (panels.length < 2) return first;

    // Words of the first pass that fall in no panel (e.g. margins) stay.
    const inPanel = new Set(panels.flatMap((p) => p.words));
    const words: OcrWord[] = first.filter((word) => !inPanel.has(word));

    for (const [i, panel] of panels.entries()) {
      progress?.(`reading panel ${i + 1} of ${panels.length}`, i / panels.length);
      onProgress = undefined; // keep the panel message instead of Tesseract's
      const again = await readArea(w, cropPixels(pixels, panel.box), panel.background, panel.box, (i + 1) * 1000);
      words.push(...(score(again) > score(panel.words) ? again : panel.words));
    }
    return words;
  } finally {
    onProgress = undefined;
  }
}
