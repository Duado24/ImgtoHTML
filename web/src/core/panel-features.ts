import { colorDistance, dominantColor, localBackground } from "./colors";
import type { Box, OcrWord, Pixels } from "./types";
import type { LayoutComponent } from "./vision-layout";

export const MONO_FONT = "Consolas,'Courier New',monospace";
export const UI_FONT = "'Segoe UI',Arial,sans-serif";
export interface FontMeasurement { family: string; evidence: "symbols" | "words" | "insufficient"; variation: number | null }
const median = (ns: number[]) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)] ?? 0;
/** Measure character advance, not glyph ink width (i and W have different ink even in monospace). */
export function measureFont(words: readonly OcrWord[], fallback: string): FontMeasurement {
  const advances = words.flatMap((w) => {
    const symbols = [...(w.symbols ?? [])].sort((a, b) => a.x - b.x);
    return symbols.slice(1).map((s, i) => s.x - symbols[i]!.x).filter((n) => n > 0);
  });
  const widths = words.filter((w) => /^[a-zA-Z]{3,}$/.test(w.text)).map((w) => w.width / w.text.length);
  const samples = advances.length >= 12 ? advances : widths;
  if (samples.length < 4) return { family: fallback, evidence: "insufficient", variation: null };
  const mid = median(samples);
  const variation = Math.sqrt(samples.reduce((n, x) => n + (x - mid) ** 2, 0) / samples.length) / Math.max(1, mid);
  return { family: variation < 0.16 ? MONO_FONT : UI_FONT, evidence: advances.length >= 12 ? "symbols" : "words", variation };
}

/** Deliberately narrow: only icon-like readings in the upper-right chrome area.
 * Names, code, numbers, file extensions, and ambiguous ordinary words survive. */
export function chromeNoise(word: OcrWord, component: LayoutComponent): boolean {
  if (!["sidebar", "toolbar", "menu"].includes(component.type) || word.confidence < 0 || word.confidence >= 60) return false;
  if (word.y > component.box.y + Math.min(55, component.box.height * 0.2) || word.x < component.box.x + component.box.width * 0.6) return false;
  return /^(?:[aeiou]{3,}|@[a-z]{2,}|[^a-z0-9]{2,})$/i.test(word.text);
}

/** Separate visible controls only at a substantial gap or a measured background boundary. */
export function splitItems(words: readonly OcrWord[], pixels: Pixels): OcrWord[][] {
  const ordered = [...words].sort((a, b) => a.x - b.x);
  const charWidth = median(words.map((w) => w.width / Math.max(1, w.text.length)));
  const groups: OcrWord[][] = [];
  for (const word of ordered) {
    const group = groups.at(-1), previous = group?.at(-1);
    const gap = previous ? word.x - previous.x - previous.width : 0;
    const changed = previous && colorDistance(localBackground(pixels, previous), localBackground(pixels, word)) > 18;
    if (!previous || gap > Math.max(12, charWidth * 2.4) || (gap > 2 && changed)) groups.push([word]);
    else group!.push(word);
  }
  return groups;
}

export function itemBox(words: readonly OcrWord[], panel: Box): Box {
  const x = Math.max(panel.x, Math.min(...words.map((w) => w.x)) - 4);
  const right = Math.min(panel.x + panel.width, Math.max(...words.map((w) => w.x + w.width)) + 4);
  return { x, y: panel.y, width: right - x, height: panel.height };
}
export const panelBackground = (pixels: Pixels, box: Box) => dominantColor(pixels, box);
