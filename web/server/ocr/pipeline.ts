import sharp from "sharp";
import { dominantColor } from "../../src/core/colors";
import { cropPixels, inkImage, ocrScale } from "../../src/core/preprocess";
import { segment, type Leaf, type Region } from "../../src/core/regions";
import type { Box, OcrWord, Pixels, RGB } from "../../src/core/types";
import type { OcrEngine } from "./engine";

const PAD = 8;
export type Progress = (status: string) => void;

async function readArea(engine: OcrEngine, pixels: Pixels, background: RGB, origin: Box, blockBase: number): Promise<OcrWord[]> {
  const ink = inkImage(pixels, background);
  const scale = ocrScale(ink.width + 2 * PAD, ink.height + 2 * PAD);
  // Resize the ink first, then add the scaled margin (sharp executes resize
  // before extend). The same original-pixel PAD/scale transform applies.
  const pad = Math.round(PAD * scale);
  const { data: png, info } = await sharp(Buffer.from(ink.data), { raw: { width: ink.width, height: ink.height, channels: 4 } })
    .resize(Math.round(ink.width * scale), Math.round(ink.height * scale))
    .extend({ top: pad, right: pad, bottom: pad, left: pad, background: "#ffffff" })
    .png().toBuffer({ resolveWithObject: true });
  const box = (b: Box): Box => ({
    x: Math.round((b.x - pad) / scale) + origin.x,
    y: Math.round((b.y - pad) / scale) + origin.y,
    width: Math.max(1, Math.round(b.width / scale)),
    height: Math.max(1, Math.round(b.height / scale)),
  });
  return (await engine.recognize({ png, width: info.width, height: info.height })).map((word) => ({
    ...word, ...box(word), block: blockBase + word.block,
    symbols: word.symbols?.map((s) => ({ text: s.text, ...box(s) })),
  }));
}

const leaves = (r: Region): Leaf[] => r.kind === "leaf" ? [r] : r.children.flatMap(leaves);
const score = (words: readonly OcrWord[]) => words.reduce((sum, w) =>
  sum + Math.max(0, w.confidence) * (w.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);

/** Same ink preprocessing and per-panel score selection as the browser pipeline. */
export async function recognizeWords(engine: OcrEngine, pixels: Pixels, progress?: Progress): Promise<OcrWord[]> {
  progress?.("Reading text…");
  const whole = { x: 0, y: 0, width: pixels.width, height: pixels.height };
  const first = await readArea(engine, pixels, dominantColor(pixels), whole, 0);
  const panels = leaves(segment(pixels, first)).filter((leaf) => leaf.words.length > 0);
  if (panels.length < 2) return first;
  const inPanel = new Set(panels.flatMap((p) => p.words));
  const words = first.filter((word) => !inPanel.has(word));
  for (const [i, panel] of panels.entries()) {
    progress?.(`Reading panel ${i + 1} of ${panels.length}…`);
    const again = await readArea(engine, cropPixels(pixels, panel.box), panel.background, panel.box, (i + 1) * 1000);
    words.push(...(score(again) > score(panel.words) ? again : panel.words));
  }
  return words;
}
