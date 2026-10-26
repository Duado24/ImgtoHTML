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
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(pixels.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(pixels.height, Math.ceil(box.y + box.height));
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

export function colorDistance(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function sameColor(a: RGB | undefined, b: RGB | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}

/** Most common color in a box (the whole image when no box is given). */
export function dominantColor(pixels: Pixels, box: Box = whole(pixels)): RGB {
  return unpack(mostCommon(countRegion(pixels, box)) ?? 0);
}

/** Background right around a word: most common color in a `pad`-pixel
 *  frame just outside its box (inside the box it's mostly letters). */
export function localBackground(pixels: Pixels, box: Box, pad = 2): RGB {
  const outer = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  const counts = new Map<number, number>();
  countRegion(pixels, { ...outer, height: pad }, counts); // top
  countRegion(pixels, { ...outer, y: box.y + box.height, height: pad }, counts); // bottom
  countRegion(pixels, { x: outer.x, y: box.y, width: pad, height: box.height }, counts); // left
  countRegion(pixels, { x: box.x + box.width, y: box.y, width: pad, height: box.height }, counts); // right
  const best = mostCommon(counts);
  return best === undefined ? dominantColor(pixels, box) : unpack(best);
}

/** Color of the "ink" in a small box (one letter) on a known background:
 *  the average of the pixels that differ most from the background.
 *  Averaging cancels ClearType's blue/orange letter edges, which a
 *  most-common-pixel count would pick up. `weight` = pixels averaged. */
export function inkColor(
  pixels: Pixels,
  box: Box,
  background: RGB,
  /** Pixels at least this share of the strongest difference are averaged. */
  core = 0.7,
): { color: RGB; weight: number } | undefined {
  const counts = countRegion(pixels, box);
  let strongest = 0;
  for (const key of counts.keys()) strongest = Math.max(strongest, colorDistance(unpack(key), background));
  if (strongest < 24) return undefined;

  const sum = [0, 0, 0];
  let weight = 0;
  for (const [key, count] of counts) {
    const c = unpack(key);
    if (colorDistance(c, background) >= core * strongest) {
      sum[0]! += c[0] * count;
      sum[1]! += c[1] * count;
      sum[2]! += c[2] * count;
      weight += count;
    }
  }
  return { color: [Math.round(sum[0]! / weight), Math.round(sum[1]! / weight), Math.round(sum[2]! / weight)], weight };
}

/** Height of the small letters (a, e, o…) in a word, in pixels: the band
 *  of rows where ink is densest. Ascenders and descenders (l, p, g) are
 *  thin, so their rows are sparse and fall outside the band. */
export function xHeight(pixels: Pixels, box: Box, background: RGB): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const x1 = Math.min(pixels.width, Math.ceil(box.x + box.width));
  const y0 = Math.max(0, Math.floor(box.y));
  const y1 = Math.min(pixels.height, Math.ceil(box.y + box.height));
  const density: number[] = [];

  for (let y = y0; y < y1; y++) {
    let ink = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * pixels.width + x) * 4;
      const c: RGB = [pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!];
      if (colorDistance(c, background) > 60) ink++;
    }
    density.push(ink);
  }
  const peak = Math.max(0, ...density);
  return peak === 0 ? 0 : density.filter((d) => d >= 0.5 * peak).length;
}

/** Group similar colors into a small palette, so one text color measured
 *  on many letters comes out as one color, not dozens of near-copies.
 *  Returns the palette and, for each sample, its palette entry. */
export function buildPalette(
  samples: readonly { color: RGB; weight: number }[],
  threshold = 30,
): { palette: RGB[]; assigned: number[] } {
  type Cluster = { sum: [number, number, number]; weight: number; center: RGB };
  const clusters: Cluster[] = [];
  const recenter = (c: Cluster) => {
    c.center = [Math.round(c.sum[0] / c.weight), Math.round(c.sum[1] / c.weight), Math.round(c.sum[2] / c.weight)];
  };
  const nearest = (color: RGB) => {
    let best = -1;
    let bestD = Infinity;
    clusters.forEach((c, i) => {
      const d = colorDistance(color, c.center);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return { index: best, distance: bestD };
  };

  // Heaviest samples first, so clusters start at well-measured colors.
  const order = samples.map((_, i) => i).sort((a, b) => samples[b]!.weight - samples[a]!.weight);
  for (const i of order) {
    const { color, weight } = samples[i]!;
    const { index, distance } = nearest(color);
    if (index >= 0 && distance <= threshold) {
      const c = clusters[index]!;
      c.sum[0] += color[0] * weight;
      c.sum[1] += color[1] * weight;
      c.sum[2] += color[2] * weight;
      c.weight += weight;
      recenter(c);
    } else {
      clusters.push({ sum: [color[0] * weight, color[1] * weight, color[2] * weight], weight, center: color });
    }
  }

  return { palette: clusters.map((c) => c.center), assigned: samples.map((s) => nearest(s.color).index) };
}

/** Text color inside a box on a known background: the most common color
 *  among the strongest-contrast pixels (anti-aliased edges are blends,
 *  so they're skipped). Undefined when nothing stands out. */
export function textColor(pixels: Pixels, box: Box, background: RGB): RGB | undefined {
  const counts = countRegion(pixels, box);
  const scored = [...counts].map(([key, count]) => ({ key, count, c: contrast(unpack(key), background) }));
  const strongest = Math.max(0, ...scored.map((s) => s.c));
  if (strongest < 1.5) return undefined;

  const threshold = Math.max(1.5, 0.75 * strongest);
  let best: number | undefined;
  let bestCount = 0;
  for (const { key, count, c } of scored) {
    if (c >= threshold && count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best === undefined ? undefined : unpack(best);
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
