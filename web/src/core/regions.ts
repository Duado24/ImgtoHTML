/** Find the panels of an application screenshot (sidebar, tab bar,
 *  editor, terminal…) from the thin separator lines between them.
 *
 *  A separator is a 1–3 px line of one color that runs the full length of
 *  the area being split, differs from what is on both sides of it, and
 *  doesn't cut through any word. Areas are split recursively (an "XY-cut"),
 *  which gives a tree that maps onto nested HTML boxes. */

import { colorDistance, dominantColor } from "./colors";
import type { Box, OcrWord, Pixels, RGB } from "./types";

export interface Leaf {
  kind: "leaf";
  box: Box;
  background: RGB;
  words: OcrWord[];
}

export interface Split {
  kind: "split";
  box: Box;
  background: RGB;
  /** "row": children side by side. "column": children stacked. */
  direction: "row" | "column";
  children: Region[];
  separator: RGB;
}

export type Region = Leaf | Split;

interface Line {
  /** First and last pixel (inclusive) across the line's thickness. */
  from: number;
  to: number;
  color: RGB;
}

const MAX_THICKNESS = 3;
/** Share of a line's pixels that must have exactly its color. */
const UNIFORM = 0.95;
/** How different a line must be from both sides. */
const DISTINCT = 8;
/** Don't split areas smaller than this. */
const MIN_SIZE = 24;
const MAX_DEPTH = 6;

/** Pixel color as a packed number, for quick comparisons. */
function at(pixels: Pixels, x: number, y: number): number {
  const i = (y * pixels.width + x) * 4;
  return (pixels.data[i]! << 16) | (pixels.data[i + 1]! << 8) | pixels.data[i + 2]!;
}

const unpack = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

/** For each position across `axis`, the line's dominant color and how
 *  uniform it is. axis "x" = vertical lines (one per column). */
function profile(pixels: Pixels, box: Box, axis: "x" | "y") {
  const across = axis === "x" ? box.width : box.height;
  const along = axis === "x" ? box.height : box.width;
  const colors: number[] = [];
  const uniform: boolean[] = [];

  for (let i = 0; i < across; i++) {
    const counts = new Map<number, number>();
    for (let j = 0; j < along; j++) {
      const p = axis === "x" ? at(pixels, box.x + i, box.y + j) : at(pixels, box.x + j, box.y + i);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = 0;
    for (const [p, c] of counts) if (c > bestCount) [best, bestCount] = [p, c];
    colors.push(best);
    uniform.push(bestCount / along >= UNIFORM);
  }
  return { colors, uniform };
}

/** OCR often "reads" a separator line or an icon as a junk word ("~~", "|").
 *  Those must not stop a split. */
const isJunk = (w: OcrWord) => w.confidence < 60 || !/[\p{L}\p{N}]/u.test(w.text);

/** True if a line at offsets [from, to] across `axis` would cut a real word. */
function cutsWord(words: readonly OcrWord[], box: Box, axis: "x" | "y", from: number, to: number): boolean {
  const lo = (axis === "x" ? box.x : box.y) + from;
  const hi = (axis === "x" ? box.x : box.y) + to;
  return words.some((w) => {
    if (isJunk(w)) return false;
    const start = axis === "x" ? w.x : w.y;
    const end = start + (axis === "x" ? w.width : w.height);
    return start < hi + 1 && end > lo;
  });
}

function findLines(pixels: Pixels, box: Box, words: readonly OcrWord[], axis: "x" | "y"): Line[] {
  const across = axis === "x" ? box.width : box.height;
  const along = axis === "x" ? box.height : box.width;
  if (across < MIN_SIZE || along < MIN_SIZE) return [];

  const { colors, uniform } = profile(pixels, box, axis);
  const lines: Line[] = [];
  const margin = 4; // the area's own edges aren't separators

  for (let i = margin; i < across - margin; i++) {
    if (!uniform[i]) continue;
    // Extend over neighbours of the same color (lines 1–3 px thick).
    let j = i;
    while (j + 1 < across - margin && uniform[j + 1] && colors[j + 1] === colors[i]) j++;
    const color = unpack(colors[i]!);
    const before = unpack(colors[i - 1]!);
    const after = unpack(colors[j + 1]!);

    if (
      j - i + 1 <= MAX_THICKNESS &&
      colorDistance(color, before) > DISTINCT &&
      colorDistance(color, after) > DISTINCT &&
      !cutsWord(words, box, axis, i, j)
    ) {
      lines.push({ from: i, to: j, color });
    }
    i = j;
  }
  return lines;
}

const inside = (w: OcrWord, b: Box) => {
  const cx = w.x + w.width / 2;
  const cy = w.y + w.height / 2;
  return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
};

function leaf(pixels: Pixels, box: Box, words: OcrWord[]): Leaf {
  return { kind: "leaf", box, background: dominantColor(pixels, box), words };
}

export function segment(pixels: Pixels, words: readonly OcrWord[], box?: Box, depth = 0): Region {
  box ??= { x: 0, y: 0, width: pixels.width, height: pixels.height };
  const mine = words.filter((w) => inside(w, box));
  if (depth >= MAX_DEPTH) return leaf(pixels, box, mine);

  // Stacked panels first (tab bar / editor / terminal), then side by side.
  for (const axis of ["y", "x"] as const) {
    const lines = findLines(pixels, box, mine, axis);
    if (lines.length === 0) continue;

    const parts: Box[] = [];
    let start = 0;
    const size = axis === "x" ? box.width : box.height;
    for (const end of [...lines.map((l) => l.from), size]) {
      if (end - start >= 2) {
        parts.push(
          axis === "x"
            ? { x: box.x + start, y: box.y, width: end - start, height: box.height }
            : { x: box.x, y: box.y + start, width: box.width, height: end - start },
        );
      }
      const line = lines.find((l) => l.from === end);
      start = line ? line.to + 1 : end;
    }
    if (parts.length === 0) continue;

    // Thin empty strips at the outer edges are page margin or window
    // frame around the app, not panels.
    const real = (p: Box) => mine.some((w) => !isJunk(w) && inside(w, p));
    const thin = (p: Box) => (axis === "x" ? p.width : p.height) <= EDGE_STRIP;
    while (parts.length > 1 && thin(parts[0]!) && !real(parts[0]!)) parts.shift();
    while (parts.length > 1 && thin(parts[parts.length - 1]!) && !real(parts[parts.length - 1]!)) parts.pop();

    // Most common separator color.
    const separator = lines.map((l) => l.color).sort(
      (a, b) =>
        lines.filter((l) => colorDistance(l.color, b) < 1).length -
        lines.filter((l) => colorDistance(l.color, a) < 1).length,
    )[0]!;

    if (parts.length === 1) {
      // Only margins were cut off: carry on inside.
      return segment(pixels, mine, parts[0]!, depth + 1);
    }

    return {
      kind: "split",
      box,
      background: dominantColor(pixels, box),
      direction: axis === "x" ? "row" : "column",
      children: parts.map((p) => segment(pixels, mine, p, depth + 1)),
      separator,
    };
  }

  return leaf(pixels, box, mine);
}

/** Edge strips up to this thick, with no real words, are dropped. */
const EDGE_STRIP = 16;
