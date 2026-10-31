/** Color math for readable output: WCAG contrast, and moving a text color's
 *  lightness until it reads on its background. */

import type { RGB } from "./types";

export const BLACK: RGB = [0, 0, 0];
export const WHITE: RGB = [255, 255, 255];

export function rgbHex(color: RGB): string {
  return "#" + color.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** "#aabbcc" → [170, 187, 204]. */
export function hexRgb(hex: string): RGB {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
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

export function sameColor(a: RGB | undefined, b: RGB | undefined): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Black or white, whichever reads better on `background`. */
export function readableOn(background: RGB): RGB {
  return contrast(WHITE, background) >= contrast(BLACK, background) ? WHITE : BLACK;
}

/** % that keeps the sign of the divisor, as color wheels need. */
const mod = (a: number, b: number) => ((a % b) + b) % b;

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

  return [mod(h / 6, 1), l, s];
}

export function hlsToRgb(h: number, l: number, s: number): [r: number, g: number, b: number] {
  if (s === 0) return [l, l, l];
  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
  const m1 = 2 * l - m2;

  const v = (hue: number): number => {
    hue = mod(hue, 1);
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
    const candidate = hlsToRgb(h, lightness, s).map((v) => Math.round(255 * v)) as unknown as RGB;
    const away = Math.abs(lightness - oldL);
    if (contrast(candidate, background) >= minimum && away < bestDistance) {
      best = candidate;
      bestDistance = away;
    }
  }

  return best ?? readableOn(background);
}
