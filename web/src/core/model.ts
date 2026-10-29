/** The structured screenshot model: what was read, where, by which source,
 *  and how sure it is. Regions, lines and spans have IDs that only depend
 *  on their position, so a region can be re-read or reviewed on its own
 *  and keep its ID. Later sources (vision model, user corrections) add to
 *  the same structure instead of replacing the OCR result. */

import { rgbHex } from "./colors";
import { layoutWords } from "./layout";
import type { Leaf, Region } from "./regions";
import { classifyLine, suggestFix, type LineRole } from "./terminal";
import type { Box, Kind, OcrWord } from "./types";

export const MODEL_VERSION = 1;

/** "rule": a fix suggested by a known pattern (e.g. "1s" → "ls" in a command). */
export type Source = "ocr" | "vision" | "user" | "rule";

/** Where a region stands in the review loop. */
export type ReviewState = "pending" | "approved" | "corrected" | "skipped";

export interface Reading {
  source: Source;
  text: string;
  /** 0–1, or null when the source doesn't say. */
  confidence: number | null;
}

export interface Span extends Reading {
  /** "r2.l5.w1": region 2, line 5, word 1 (all counted from 1). */
  id: string;
  box: Box;
  /** Other sources' readings of the same span, for review. */
  alternatives: Reading[];
}

export interface ModelLine {
  id: string;
  box: Box;
  /** Terminals only: command (after a prompt), output or error. */
  role?: LineRole;
  /** Terminals only: the prompt text at the start of a command line. */
  prompt?: string;
  spans: Span[];
}

export type FlagReason = "low-confidence" | "confusable" | "suggested-fix" | "sources-disagree" | "cut-off";

export interface Flag {
  reason: FlagReason;
  spanId: string;
  detail: string;
}

export interface ModelRegion {
  id: string;
  box: Box;
  /** "panel" until a vision model labels it (terminal, editor, sidebar…). */
  role: string;
  background: string;
  lines: ModelLine[];
  /** Letter-weighted mean of the span confidences, 0–1 (null: no text). */
  confidence: number | null;
  flags: Flag[];
  review: ReviewState;
  /** Keeps the checklist item after a correction clears its original flags. */
  reviewRequested?: boolean;
}

export interface ScreenshotModel {
  version: typeof MODEL_VERSION;
  width: number;
  height: number;
  kind: Kind;
  regions: ModelRegion[];
}

/** Below this (0–1), a span is flagged for review. */
export const LOW_CONFIDENCE = 0.7;
/** Spans with lookalike characters are flagged below this in terminals and code. */
export const CONFUSABLE_CONFIDENCE = 0.9;
/** Lookalikes that change what a command or code line does. */
const LOOKALIKES = /[lI1|O0'"`‘’“”–—~]/;

const union = (boxes: readonly Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
};

const letters = (text: string) => text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const leaves = (r: Region): Leaf[] => (r.kind === "leaf" ? [r] : r.children.flatMap(leaves));

function buildRegion(id: string, box: Box, background: string, words: readonly OcrWord[], kind: Kind): ModelRegion {
  const lines: ModelLine[] = [];
  const flags: Flag[] = [];
  const strict = kind === "terminal" || kind === "code";

  for (const [i, row] of layoutWords(words).rows.entries()) {
    if (!row.words.length) continue;
    const lineId = `${id}.l${i + 1}`;
    const terminal = kind === "terminal" ? classifyLine(row.text.trimStart()) : null;
    const promptEnd = terminal ? row.text.length - row.text.trimStart().length + terminal.prompt.length : 0;
    const firstCommand = row.words.findIndex((w) => w.start >= promptEnd);
    const spans = row.words.map(({ word }, j): Span => {
      const confidence = word.confidence < 0 ? null : round3(word.confidence / 100);
      const span: Span = {
        id: `${lineId}.w${j + 1}`,
        source: "ocr",
        text: word.text,
        confidence,
        box: { x: word.x, y: word.y, width: word.width, height: word.height },
        alternatives: [],
      };
      if (confidence !== null && confidence < LOW_CONFIDENCE) {
        flags.push({ reason: "low-confidence", spanId: span.id, detail: `OCR confidence ${Math.round(confidence * 100)}%` });
      } else if (strict && LOOKALIKES.test(word.text) && (confidence === null || confidence < CONFUSABLE_CONFIDENCE)) {
        flags.push({ reason: "confusable", spanId: span.id, detail: `Check lookalike characters in "${word.text}"` });
      }
      const fix = terminal?.role === "command" && firstCommand >= 0 && j >= firstCommand ? suggestFix(word.text, j === firstCommand) : null;
      if (fix) {
        span.alternatives.push({ source: "rule", text: fix.to, confidence: null });
        flags.push({ reason: "suggested-fix", spanId: span.id, detail: `"${fix.from}" → "${fix.to}": ${fix.why}` });
      }
      return span;
    });
    const roles = terminal ? { role: terminal.role, ...(terminal.prompt ? { prompt: terminal.prompt } : {}) } : {};
    lines.push({ id: lineId, box: union(spans.map((s) => s.box)), ...roles, spans });
  }

  const spans = lines.flatMap((l) => l.spans).filter((s) => s.confidence !== null);
  const weight = spans.reduce((sum, s) => sum + Math.max(1, letters(s.text)), 0);
  return {
    id,
    box,
    role: "panel",
    background,
    lines,
    confidence: weight ? round3(spans.reduce((sum, s) => sum + s.confidence! * Math.max(1, letters(s.text)), 0) / weight) : null,
    flags,
    review: flags.length ? "pending" : "approved",
  };
}

/** One region per panel found in the screenshot, in reading order. Words
 *  outside every panel (rare) get a last region covering the whole image. */
export function buildModel(width: number, height: number, kind: Kind, tree: Region, words: readonly OcrWord[]): ScreenshotModel {
  const panels = leaves(tree);
  const placed = new Set(panels.flatMap((p) => p.words));
  const regions = panels.map((leaf, i) => buildRegion(`r${i + 1}`, leaf.box, rgbHex(leaf.background), leaf.words, kind));
  const rest = words.filter((w) => !placed.has(w));
  if (rest.length) {
    regions.push(buildRegion(`r${regions.length + 1}`, { x: 0, y: 0, width, height }, rgbHex(tree.background), rest, kind));
  }
  return { version: MODEL_VERSION, width, height, kind, regions };
}

/** Flags of regions still waiting for review, most urgent region first. */
export function flagsByRegion(model: ScreenshotModel): { region: string; confidence: number | null; flags: Flag[] }[] {
  return model.regions
    .filter((r) => r.flags.length && r.review === "pending")
    .map((r) => ({ region: r.id, confidence: r.confidence, flags: r.flags }))
    .sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
}

/** Flagged words still waiting for a person's review: only the doubtful
 *  words, not every word around them. A pending region whose flags were
 *  cleared by a correction still needs its final look, so it counts one.
 *  Reviewed or skipped regions keep their evidence but no longer count. */
export function countWordsToCheck(model: ScreenshotModel): number {
  return model.regions
    .filter((region) => region.review === "pending")
    .reduce((count, region) => {
      const words = new Map(region.lines.flatMap((line) => line.spans).map((span) => [span.id, span.text]));
      const flagged = new Set(region.flags.map((flag) => flag.spanId).filter((id) => /[\p{L}\p{N}]/u.test(words.get(id) ?? "")));
      return count + Math.max(1, flagged.size);
    }, 0);
}
