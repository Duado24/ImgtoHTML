/** Prepare a screenshot for OCR.
 *
 *  Tesseract is trained on dark print on white paper. Screenshots are
 *  often light (or colored, or dim gray) text on a dark background, at a
 *  small size. So every pixel becomes "how different is it from the
 *  background": the background turns white and any text, whatever its
 *  color, turns dark. The browser then enlarges the result 3× (see
 *  src/browser/ocr.ts). On a VS Code screenshot this took the misread
 *  words from ~37 to ~6 and recovered the dim panel labels. */

import type { Box, Pixels, RGB } from "./types";

/** Copy of one rectangle of an image. */
export function cropPixels(pixels: Pixels, box: Box): Pixels {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const width = Math.max(1, Math.min(pixels.width, Math.ceil(box.x + box.width)) - x0);
  const height = Math.max(1, Math.min(pixels.height, Math.ceil(box.y + box.height)) - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * pixels.width + x0) * 4;
    data.set(pixels.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** Grayscale "ink" image: white where a pixel matches `background`,
 *  darker the more it differs. `gain` 2 means a difference of 128
 *  (average over R, G, B) is already full black. */
export function inkImage(pixels: Pixels, background: RGB, gain = 2): Pixels {
  const [br, bg, bb] = background;
  const src = pixels.data;
  const data = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    const diff = (Math.abs(src[i]! - br) + Math.abs(src[i + 1]! - bg) + Math.abs(src[i + 2]! - bb)) / 3;
    const v = 255 - gain * diff; // Uint8ClampedArray clamps to 0–255
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: pixels.width, height: pixels.height, data };
}

/** How much to enlarge before OCR: 3×, but keep the long side ≤ 4500 px
 *  (larger images get slow and Tesseract gains nothing). Never shrinks. */
export function ocrScale(width: number, height: number): number {
  return Math.max(1, Math.min(3, 4500 / Math.max(width, height)));
}
