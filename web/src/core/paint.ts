/** Text with colors: a line is a list of runs, each with one look. */

import type { RGB } from "./types";

/** A stretch of text with one look. Missing color/background = inherit. */
export interface Run {
  text: string;
  color?: RGB;
  background?: RGB;
}

export interface PaintedLine {
  runs: Run[];
  /** Whole-line highlight (e.g. the selected row in a file list). */
  background?: RGB;
}

export function plainLines(lines: readonly string[]): PaintedLine[] {
  return lines.map((text) => ({ runs: text ? [{ text }] : [] }));
}

export function lineText(line: PaintedLine): string {
  return line.runs.map((r) => r.text).join("");
}
