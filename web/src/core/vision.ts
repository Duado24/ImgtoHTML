/** Add a vision model's reading to the screenshot model. The vision model
 *  never replaces OCR text: where the two disagree, its reading becomes an
 *  alternative on the span and the span is flagged for review. It does
 *  name each region (terminal, code, sidebar…). */

import type { ModelRegion, ScreenshotModel, Span } from "./model";

export interface RegionReading {
  regionId: string;
  /** What the region is: terminal, code, sidebar, tabs, dialog, diagram, text… */
  role: string;
  /** The region's text as the vision model reads it, lines separated by \n. */
  text: string;
}

const tokens = (text: string) => text.split(/\s+/).filter(Boolean);

/** Edit distance between two word lists, plus which words pair up. */
function alignWords(a: readonly string[], b: readonly string[]): { cost: number; pairs: [number, number | null][] } {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
    }
  }
  const pairs: [number, number | null][] = [];
  for (let i = n, j = m; i > 0; ) {
    if (j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)) pairs.push([--i, --j]);
    else if (d[i]![j] === d[i - 1]![j]! + 1) pairs.push([--i, null]);
    else j--;
  }
  return { cost: d[n]![m]!, pairs: pairs.reverse() };
}

/** Share of a line's words that must match for two lines to count as the same line. */
const SAME_LINE = 0.5;

function mergeRegion(region: ModelRegion, reading: RegionReading): ModelRegion {
  const visionLines = reading.text.split("\n").map(tokens).filter((l) => l.length);
  const used = new Set<number>();
  const flags = region.flags.filter((f) => f.reason !== "sources-disagree");

  const lines = region.lines.map((line) => {
    const ocr = line.spans.map((s) => s.text);
    // The vision line that needs the fewest word edits, if close enough.
    let best: { index: number; cost: number; pairs: [number, number | null][] } | null = null;
    for (const [index, words] of visionLines.entries()) {
      if (used.has(index)) continue;
      const { cost, pairs } = alignWords(ocr, words);
      if (!best || cost < best.cost) best = { index, cost, pairs };
    }
    if (!best || best.cost > Math.max(1, ocr.length * (1 - SAME_LINE))) return line;
    used.add(best.index);

    const words = visionLines[best.index]!;
    const spans = line.spans.map((span, i): Span => {
      const j = best.pairs.find(([k]) => k === i)?.[1];
      const seen = j === null || j === undefined ? null : words[j]!;
      const alternatives = span.alternatives.filter((a) => a.source !== "vision");
      if (seen === null || seen === span.text) return { ...span, alternatives };
      flags.push({ reason: "sources-disagree", spanId: span.id, detail: `OCR read "${span.text}", vision model read "${seen}"` });
      return { ...span, alternatives: [...alternatives, { source: "vision", text: seen, confidence: null }] };
    });
    return { ...line, spans };
  });

  return { ...region, role: reading.role || region.role, lines, flags, review: flags.length ? "pending" : region.review };
}

export function mergeVision(model: ScreenshotModel, readings: readonly RegionReading[]): ScreenshotModel {
  const byId = new Map(readings.map((r) => [r.regionId, r]));
  return { ...model, regions: model.regions.map((r) => (byId.has(r.id) ? mergeRegion(r, byId.get(r.id)!) : r)) };
}
