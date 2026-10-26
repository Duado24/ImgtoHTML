/** Give each character of the reconstructed text the color it has in
 *  the screenshot, and keep highlighted backgrounds (a selected file, an
 *  active tab). Colors come from the pixels inside each OCR character
 *  box, so syntax highlighting survives.
 *
 *  Two steps: measureLooks() measures every letter of every word and
 *  snaps the results to one shared palette; paintLines() then lays those
 *  colors onto the lines of one area. */

import { buildPalette, colorDistance, fixContrast, inkColor, localBackground, rgbHex, sameColor } from "./colors";
import type { LayoutLine } from "./layout";
import type { OcrWord, Pixels, RGB } from "./types";

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

/** How one OCR word looks in the screenshot. */
export interface WordLook {
  /** Color right around the word. */
  background: RGB;
  /** One color per UTF-16 unit of the word's text (undefined = not measured). */
  letters: (RGB | undefined)[];
}

/** Below this, two backgrounds count as the same (screens dither and blend). */
const SAME_BACKGROUND = 10;

/** Lines with no color information: one run each. */
export function plainLines(lines: readonly string[]): PaintedLine[] {
  return lines.map((text) => ({ runs: text ? [{ text }] : [] }));
}

export function lineText(line: PaintedLine): string {
  return line.runs.map((r) => r.text).join("");
}

/** Two colors whose directions from the background are closer than this
 *  (cosine) are one text color. VS Code's gray `(` and yellow `print`
 *  are at 0.987, so this keeps them apart. */
const SAME_HUE = 0.994;
/** A token inside a word keeps its own color only if its hue is at least
 *  this far from the word's (cosine below this). Gray vs yellow: 0.990. */
const OWN_HUE = 0.993;
/** Colors with less spread than this between R, G and B are gray. */
const GRAY_SPREAD = 24;
/** Share of the strongest pixels averaged when measuring ink. */
const CORE = 0.85;

type Vec = [number, number, number];
const sub = (a: RGB, b: RGB): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (v: Vec) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec): Vec => {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const toRgb = (v: Vec): RGB => v.map((x) => Math.max(0, Math.min(255, Math.round(x)))) as unknown as RGB;

/** Near-gray colors become true gray (ClearType tints gray text slightly). */
function neutral(c: RGB): RGB {
  if (Math.max(...c) - Math.min(...c) >= GRAY_SPREAD) return c;
  const v = Math.round((c[0] + c[1] + c[2]) / 3);
  return [v, v, v];
}

/** Measure the background and text colors of every word.
 *
 *  Single letters at screen size are too small to measure reliably (their
 *  edges are tinted by ClearType), so colors are measured on whole words,
 *  and on code tokens inside a word (`print`, `(`, `"Hello`) to keep syntax
 *  highlighting.
 *
 *  A dim-looking token can be a thin one (l, i, !) rather than a dim color:
 *  its color lies on the line from the background towards the true text
 *  color, just closer to the background. So colors are grouped by
 *  *direction* from their background (their hue), and every part of a word
 *  in one direction gets the strength of that word's strongest part. A dim
 *  label stays dim; a thin letter in a bright word becomes bright. */
export function measureLooks(pixels: Pixels, words: readonly OcrWord[]): Map<OcrWord, WordLook> {
  interface Part {
    /** Index range in the word's text. */
    from: number;
    to: number;
    ink: Vec; // color minus local background
    weight: number;
  }
  interface Measured {
    background: RGB;
    whole?: Vec;
    weight: number;
    tokens: Part[];
    group?: number;
  }
  const measured = new Map<OcrWord, Measured>();

  for (const word of words) {
    const background = localBackground(pixels, word);
    const whole = inkColor(pixels, word, background, CORE);
    const m: Measured = { background, whole: whole && sub(whole.color, background), weight: whole?.weight ?? 0, tokens: [] };
    measured.set(word, m);

    // Code tokens, measured on the union of their letters' boxes.
    const symbols = word.symbols ?? [];
    if (!whole || symbols.map((s) => s.text).join("") !== word.text) continue;
    let offset = 0;
    for (const token of word.text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu) ?? []) {
      const parts = symbols.filter((s, i) => {
        const at = symbols.slice(0, i).reduce((n, p) => n + p.text.length, 0);
        return at >= offset && at < offset + token.length;
      });
      if (parts.length && token.length < word.text.length) {
        const x = Math.min(...parts.map((p) => p.x));
        const y = Math.min(...parts.map((p) => p.y));
        const box = {
          x, y,
          width: Math.max(...parts.map((p) => p.x + p.width)) - x,
          height: Math.max(...parts.map((p) => p.y + p.height)) - y,
        };
        const ink = inkColor(pixels, box, background, CORE);
        if (ink) m.tokens.push({ from: offset, to: offset + token.length, ink: sub(ink.color, background), weight: ink.weight });
      }
      offset += token.length;
    }

    // A word mixing colors (`print("Hello,`) averages into a color it doesn't
    // have; its biggest token is the better measure of "the word's color".
    const main = m.tokens.reduce<Part | undefined>((a, t) => (!a || t.weight > a.weight ? t : a), undefined);
    if (main) m.whole = main.ink;
  }

  // Hue groups from whole words (heaviest first): these are the screenshot's text colors.
  const groups: { dir: Vec; sum: Vec }[] = [];
  const nearestGroup = (v: Vec) => {
    const dir = unit(v);
    let best = -1;
    let bestCos = -1;
    groups.forEach((g, i) => {
      const c = dot(dir, g.dir);
      if (c > bestCos) [best, bestCos] = [i, c];
    });
    return { index: best, cos: bestCos };
  };
  for (const [, m] of [...measured].sort((a, b) => b[1].weight - a[1].weight)) {
    if (!m.whole) continue;
    const { index, cos } = nearestGroup(m.whole);
    if (index >= 0 && cos >= SAME_HUE) {
      const g = groups[index]!;
      g.sum = [g.sum[0] + m.whole[0], g.sum[1] + m.whole[1], g.sum[2] + m.whole[2]];
      g.dir = unit(g.sum);
      m.group = index;
    } else {
      groups.push({ dir: unit(m.whole), sum: [...m.whole] as Vec });
      m.group = groups.length - 1;
    }
  }

  // Colors, then one palette so near-copies merge.
  const raw: { color: RGB; weight: number }[] = [];
  const spans: { word: OcrWord; from: number; to: number }[] = [];

  for (const [word, m] of measured) {
    if (!m.whole || m.group === undefined) continue;
    const wordDir = groups[m.group]!.dir;

    // Which group each token belongs to: its own only if clearly another hue
    // that is also some whole word's color; otherwise the word's.
    const tokenGroups = m.tokens.map((t) => {
      const own = nearestGroup(t.ink);
      return own.index !== m.group && own.cos >= SAME_HUE && dot(unit(t.ink), wordDir) < OWN_HUE ? own.index : m.group!;
    });

    // Strongest part per group within this word.
    const strength = new Map<number, number>([[m.group, dot(m.whole, wordDir)]]);
    m.tokens.forEach((t, i) => {
      const g = tokenGroups[i]!;
      strength.set(g, Math.max(strength.get(g) ?? 0, dot(t.ink, groups[g]!.dir)));
    });

    const colorOf = (g: number): RGB => {
      const d = groups[g]!.dir;
      const s = strength.get(g)!;
      return neutral(toRgb([m.background[0] + d[0] * s, m.background[1] + d[1] * s, m.background[2] + d[2] * s]));
    };

    raw.push({ color: colorOf(m.group), weight: m.weight });
    spans.push({ word, from: 0, to: word.text.length });
    m.tokens.forEach((t, i) => {
      if (tokenGroups[i] === m.group) return;
      raw.push({ color: colorOf(tokenGroups[i]!), weight: 1 });
      spans.push({ word, from: t.from, to: t.to });
    });
  }

  const { palette, assigned } = buildPalette(raw, 20);

  const looks = new Map<OcrWord, WordLook>();
  for (const [word, m] of measured) {
    looks.set(word, { background: m.background, letters: new Array(word.text.length).fill(undefined) });
  }
  spans.forEach((s, i) => {
    const look = looks.get(s.word)!;
    for (let k = s.from; k < s.to; k++) look.letters[k] = palette[assigned[i]!];
  });
  return looks;
}

/** Color every character of `rows`. `area` is the background of the panel
 *  the lines sit in. Every color is checked for 4.5:1 contrast against
 *  whatever it sits on, and adjusted if needed. */
export function paintLines(
  rows: readonly LayoutLine[],
  area: RGB,
  looks: ReadonlyMap<OcrWord, WordLook>,
): PaintedLine[] {
  return rows.map((row) => paintLine(row, area, looks));
}

function paintLine(row: LayoutLine, area: RGB, looks: ReadonlyMap<OcrWord, WordLook>): PaintedLine {
  const n = row.text.length;
  const color: (RGB | undefined)[] = new Array(n);
  const behind: (RGB | undefined)[] = new Array(n);

  for (const { start, word } of row.words) {
    const look = looks.get(word);
    if (!look) continue;
    const highlight = colorDistance(look.background, area) > SAME_BACKGROUND ? look.background : undefined;
    for (let i = 0; i < word.text.length; i++) {
      color[start + i] = look.letters[i];
      behind[start + i] = highlight;
    }
  }

  // Whole-line highlight when every word shares the same highlight.
  const wordBgs = row.words.map(({ start }) => behind[start]);
  const first = wordBgs[0];
  const lineBg = first && wordBgs.every((b) => sameColor(b, first)) ? first : undefined;
  if (lineBg) behind.fill(undefined);

  // Spaces between two words with the same look take that look,
  // so a highlighted tab "hello_world.py ×" stays one block.
  for (let i = 0; i < n; i++) {
    if (row.text[i] !== " ") continue;
    let j = i - 1;
    while (j >= 0 && row.text[j] === " ") j--;
    let k = i + 1;
    while (k < n && row.text[k] === " ") k++;
    if (j >= 0 && k < n) {
      if (sameColor(behind[j], behind[k])) behind[i] = behind[j];
      if (sameColor(color[j], color[k])) color[i] = color[j];
    }
  }

  // Readability: every color against what it sits on.
  const fixed = new Map<string, RGB>();
  for (let i = 0; i < n; i++) {
    const c = color[i];
    if (!c) continue;
    const bg = behind[i] ?? lineBg ?? area;
    const key = rgbHex(c) + rgbHex(bg);
    let f = fixed.get(key);
    if (!f) fixed.set(key, (f = fixContrast(c, bg)));
    color[i] = f;
  }

  // Merge neighbours with the same look into runs.
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && sameColor(last.color, color[i]) && sameColor(last.background, behind[i])) {
      last.text += row.text[i];
    } else {
      runs.push({ text: row.text[i]!, color: color[i], background: behind[i] });
    }
  }

  return lineBg ? { runs, background: lineBg } : { runs };
}

/** The most common text color in some lines (by number of letters). */
export function mainColor(lines: readonly PaintedLine[]): RGB | undefined {
  const counts = new Map<string, { color: RGB; n: number }>();
  for (const line of lines) {
    for (const run of line.runs) {
      if (!run.color) continue;
      const letters = run.text.replace(/\s/g, "").length;
      const key = rgbHex(run.color);
      const entry = counts.get(key) ?? { color: run.color, n: 0 };
      entry.n += letters;
      counts.set(key, entry);
    }
  }
  let best: { color: RGB; n: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.color;
}

/** Every distinct text color used, as hex. */
export function colorsUsed(lines: readonly PaintedLine[]): string[] {
  const set = new Set<string>();
  for (const line of lines) for (const run of line.runs) if (run.color) set.add(rgbHex(run.color));
  return [...set];
}
