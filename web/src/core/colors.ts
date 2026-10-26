import { pyMod, pyRound } from "./pymath";
import type { Box, Pixels, RGB } from "./types";

export const BLACK: RGB = [0, 0, 0];
export const WHITE: RGB = [255, 255, 255];

export function rgbHex(color: RGB): string {
  return "#" + color.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** WCAG relative luminance. */
export function luminance(color: RGB): number {
  const [r, g, b] = color.map((value) => {
    const x = value / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const [low, high] = [luminance(a), luminance(b)].sort((p, q) => p - q) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

// ------------------------------------------------------------
// Pixel counting. Colors are packed into one number (0xRRGGBB) so a Map
// can count them; Map keeps insertion order, so ties resolve to the
// color seen first, like Python's Counter.
// ------------------------------------------------------------

const pack = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const unpack = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

function countRegion(pixels: Pixels, box: Box, counts = new Map<number, number>()) {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(pixels.width, box.x + box.width);
  const y1 = Math.min(pixels.height, box.y + box.height);
  const { data, width } = pixels;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const key = pack(data[i]!, data[i + 1]!, data[i + 2]!);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function mostCommon(counts: Map<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

const whole = (pixels: Pixels): Box => ({ x: 0, y: 0, width: pixels.width, height: pixels.height });

/** Shrink to fit inside size×size by averaging blocks of pixels
 *  (stands in for Pillow's thumbnail()). Never enlarges. */
function thumbnail(pixels: Pixels, size: number): Pixels {
  const scale = Math.min(1, size / pixels.width, size / pixels.height);
  if (scale === 1) return pixels;

  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let ty = 0; ty < height; ty++) {
    const sy0 = Math.floor((ty * pixels.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * pixels.height) / height));
    for (let tx = 0; tx < width; tx++) {
      const sx0 = Math.floor((tx * pixels.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * pixels.width) / width));
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * pixels.width + x) * 4;
          sum[0]! += pixels.data[i]!;
          sum[1]! += pixels.data[i + 1]!;
          sum[2]! += pixels.data[i + 2]!;
          n++;
        }
      }
      const o = (ty * width + tx) * 4;
      data[o] = Math.round(sum[0]! / n);
      data[o + 1] = Math.round(sum[1]! / n);
      data[o + 2] = Math.round(sum[2]! / n);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Fallback when word-box measurement finds no text pixels:
 *  most common (slightly rounded) color is the background, the most
 *  common color that differs enough from it is the text. */
export function colorsFromImage(pixels: Pixels): { background: RGB; foreground: RGB } {
  const small = thumbnail(pixels, 360);
  const counts = new Map<number, number>();

  for (let i = 0; i < small.data.length; i += 4) {
    const key = pack(
      (small.data[i]! >> 3) << 3,
      (small.data[i + 1]! >> 3) << 3,
      (small.data[i + 2]! >> 3) << 3,
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const background = unpack(mostCommon(counts) ?? 0);

  let foreground: RGB | undefined;
  let best = 0;
  for (const [key, count] of counts) {
    const color = unpack(key);
    if (count >= 2 && contrast(color, background) >= 2 && count > best) {
      foreground = color;
      best = count;
    }
  }

  foreground ??= luminance(background) < 0.18 ? WHITE : BLACK;
  return { background, foreground };
}

export interface MeasuredColors {
  background: RGB;
  foreground: RGB;
  /** How common the second text color is compared with the first (0 = one color). */
  secondaryRatio: number;
}

/** Estimate background and text color, measuring text color only inside
 *  OCR word boxes (so highlight circles and window chrome are ignored).
 *  Does not reproduce multiple text colors. */
export function colorsFromWords(pixels: Pixels, boxes: readonly Box[], minContrast = 3): MeasuredColors {
  const background = unpack(mostCommon(countRegion(pixels, whole(pixels))) ?? 0);

  const counts = new Map<number, number>();
  for (const box of boxes) {
    if (box.width > 0 && box.height > 0) countRegion(pixels, box, counts);
  }

  const text = new Map<number, number>();
  for (const [key, count] of counts) {
    if (contrast(unpack(key), background) >= minContrast) text.set(key, count);
  }

  const fgKey = mostCommon(text);
  if (fgKey === undefined) {
    const fallback = colorsFromImage(pixels);
    return { ...fallback, secondaryRatio: 0 };
  }

  const foreground = unpack(fgKey);
  const distance = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  let other = 0;
  for (const [key, count] of text) {
    if (distance(unpack(key), foreground) > 80) other = Math.max(other, count);
  }

  return { background, foreground, secondaryRatio: other / text.get(fgKey)! };
}

/** The Canvas box background is always pure black or pure white:
 *  whichever is closer to the screenshot's own background. */
export function blackOrWhite(background: RGB): RGB {
  return contrast(background, BLACK) <= contrast(background, WHITE) ? BLACK : WHITE;
}

// ------------------------------------------------------------
// HLS conversion, same formulas as Python's colorsys.
// ------------------------------------------------------------

export function rgbToHls(r: number, g: number, b: number): [h: number, l: number, s: number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sumc = maxc + minc;
  const rangec = maxc - minc;
  const l = sumc / 2;
  if (minc === maxc) return [0, l, 0];

  const s = l <= 0.5 ? rangec / sumc : rangec / (2 - maxc - minc);
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;

  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2 + rc - bc;
  else h = 4 + gc - rc;

  return [pyMod(h / 6, 1), l, s];
}

export function hlsToRgb(h: number, l: number, s: number): [r: number, g: number, b: number] {
  if (s === 0) return [l, l, l];
  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
  const m1 = 2 * l - m2;

  const v = (hue: number): number => {
    hue = pyMod(hue, 1);
    if (hue < 1 / 6) return m1 + (m2 - m1) * hue * 6;
    if (hue < 0.5) return m2;
    if (hue < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - hue) * 6;
    return m1;
  };

  return [v(h + 1 / 3), v(h), v(h - 1 / 3)];
}

/** If contrast is below `minimum`, change only the text color's lightness
 *  (hue and saturation stay) to the nearest value that passes. */
export function fixContrast(foreground: RGB, background: RGB, minimum = 4.5): RGB {
  if (contrast(foreground, background) >= minimum) return foreground;

  const [h, oldL, s] = rgbToHls(foreground[0] / 255, foreground[1] / 255, foreground[2] / 255);

  let best: RGB | undefined;
  let bestDistance = Infinity;

  for (let step = 0; step <= 1000; step++) {
    const lightness = step / 1000;
    const candidate = hlsToRgb(h, lightness, s).map((v) => pyRound(255 * v)) as unknown as RGB;
    const away = Math.abs(lightness - oldL);
    if (contrast(candidate, background) >= minimum && away < bestDistance) {
      best = candidate;
      bestDistance = away;
    }
  }

  return best ?? foreground;
}
