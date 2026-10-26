/** Turn OCR word boxes back into lines of text, estimating spaces,
 *  indentation and blank lines from the gaps between boxes.
 *  Same rules as extract() in the Python version (v1.2.2 spacing). */

import { isAlnum, middle, pyLen, pyRound } from "./pymath";
import type { Box, OcrWord } from "./types";

export interface UncertainWord {
  text: string;
  confidence: number;
}

/** A line of text and where each OCR word sits in it. */
export interface LayoutLine {
  text: string;
  /** `start` is the word's index in `text` (UTF-16, as JS strings count). */
  words: { start: number; word: OcrWord }[];
}

export interface Layout {
  lines: string[];
  /** Same lines, with word positions (for coloring). */
  rows: LayoutLine[];
  uncertain: UncertainWord[];
  /** Every word box, for measuring text color. */
  boxes: Box[];
}

export function layoutWords(words: readonly OcrWord[]): Layout {
  const groups = new Map<string, OcrWord[]>();
  const uncertain: UncertainWord[] = [];

  for (const raw of words) {
    const text = raw.text.trim();
    if (!text) continue;

    if (raw.confidence >= 0 && raw.confidence < 70) {
      uncertain.push({ text, confidence: raw.confidence });
    }

    const key = `${raw.block}/${raw.paragraph}/${raw.line}`;
    // Keep the caller's object when nothing changes, so it can be used
    // as a key (convert() looks up each word's measured colors).
    const word = text === raw.text ? raw : { ...raw, text };
    const group = groups.get(key);
    if (group) group.push(word);
    else groups.set(key, [word]);
  }

  // Rows top to bottom, then left to right.
  const top = (row: OcrWord[]) => Math.min(...row.map((w) => w.y));
  const left = (row: OcrWord[]) => Math.min(...row.map((w) => w.x));
  const rows = [...groups.values()].sort((a, b) => top(a) - top(b) || left(a) - left(b));

  const boxes: Box[] = rows.flatMap((row) =>
    row.map(({ x, y, width, height }) => ({ x, y, width, height })),
  );

  if (rows.length === 0) return { lines: [], rows: [], uncertain, boxes };

  const all = rows.flat();
  const byNumber = (a: number, b: number) => a - b;

  const heights = all.map((w) => w.height).sort(byNumber);
  const lineHeight = Math.max(1, middle(heights) * 1.5);

  // Character width: from longer plain words if there are any,
  // otherwise from every word.
  const plain = all
    .filter((w) => pyLen(w.text) >= 5 && isAlnum(w.text))
    .map((w) => w.width / pyLen(w.text))
    .sort(byNumber);
  const anyWidth = all.map((w) => w.width / Math.max(1, pyLen(w.text))).sort(byNumber);
  const charWidth = Math.max(1, plain.length ? middle(plain) : middle(anyWidth));

  const leftOrigin = Math.min(...all.map((w) => w.x));

  // Spacing calibration: if the typical gap between words is wider than
  // one character, OCR boxes are tight and that extra is subtracted.
  const sortedRows = rows.map((row) => [...row].sort((a, b) => a.x - b.x));
  const gaps = sortedRows
    .flatMap((row) => row.slice(1).map((b, i) => (b.x - (row[i]!.x + row[i]!.width)) / charWidth))
    .sort(byNumber);
  const spaceExtra = gaps.length >= 5 ? Math.max(0, middle(gaps) - 1) : 0;

  const out: LayoutLine[] = [];
  let previousY: number | undefined;

  for (const row of sortedRows) {
    const y = Math.min(...row.map((w) => w.y));

    if (previousY !== undefined) {
      const missing = pyRound((y - previousY) / lineHeight) - 1;
      const blankLines = Math.max(0, Math.min(12, missing));
      for (let i = 0; i < blankLines; i++) out.push({ text: "", words: [] });
    }
    previousY = y;

    let line = "";
    let lastEnd: number | undefined;
    const placed: LayoutLine["words"] = [];

    for (const word of row) {
      if (lastEnd === undefined) {
        line = " ".repeat(Math.max(0, pyRound((word.x - leftOrigin) / charWidth)));
      } else {
        const gap = (word.x - lastEnd) / charWidth;
        line += " ".repeat(Math.max(1, pyRound(gap - spaceExtra)));
      }
      placed.push({ start: line.length, word });
      line += word.text;
      lastEnd = word.x + word.width;
    }

    out.push({ text: line, words: placed });
  }

  return { lines: out.map((l) => l.text), rows: out, uncertain, boxes };
}
