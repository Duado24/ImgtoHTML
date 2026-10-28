/** Code screenshots: clean up what OCR read (gutter line numbers, ragged
 *  indentation), detect the language, and highlight it again with the
 *  course theme, instead of guessing syntax colors from blended pixels. */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { PaintedLine, Run } from "./paint";
import type { Slot, Theme } from "./theme";
import type { RGB } from "./types";

const LANGUAGES = { python, javascript, typescript, java, c, cpp, csharp, xml, css, sql, bash, powershell, json, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

/** highlight.js scope → theme color, after VS Code Dark+. Unlisted scopes keep the text color. */
const SCOPES: Record<string, Slot> = {
  keyword: "blue",
  literal: "blue",
  "meta": "blue",
  tag: "blue",
  name: "blue",
  string: "red",
  regexp: "red",
  comment: "green",
  quote: "green",
  "title.function": "yellow",
  "title.function.invoke": "yellow",
  "title.class": "cyan",
  "title.class.inherited": "cyan",
  type: "cyan",
  built_in: "cyan",
  attr: "sky",
  "selector-class": "yellow",
  "selector-tag": "blue",
  attribute: "sky",
  variable: "sky",
  "template-variable": "sky",
  subst: "text",
  params: "text",
  number: "text",
};

export interface CodeCleanup {
  lines: string[];
  /** Gutter numbers taken off the start of lines (so copying gives clean code). */
  lineNumbersRemoved: boolean;
  /** Editor lines left out: above or below the numbered code (tabs, breadcrumbs) or hints between lines. */
  linesOutsideCode: number;
  /** Lines where curly quotes (OCR misreads) became straight ones. */
  quotesStraightened: number;
  /** Indentation step the lines were snapped to (2 or 4), or null. */
  indentUnit: number | null;
  /** Lines whose indentation was off by one space and moved to the step. */
  linesSnapped: number;
  /** Editor text above the code (tab bar, breadcrumb), for drawing the editor window. */
  header: string[];
  /** Hints between code lines (VS Code's "Debug" CodeLens). */
  hints: EditorHint[];
  /** Number of the first code line as the editor showed it. */
  firstLine: number;
}

export interface EditorHint {
  /** Index of the code line the hint sits above. */
  before: number;
  text: string;
}

const GUTTER = /^\s*(\d{1,4})(\s+|$)/;
/** A misread line number ("Bf" for 8, "i." for 14): a short token before the code column. */
const MISREAD = /^\s*\S{1,4}(\s+|$)/;
/** Share of lines that must agree before a fix is applied. */
const AGREE = 0.6;

/** Remove gutter line numbers when the numbered lines mostly count up by one
 *  (OCR misreads some), and the editor lines above and below them (tabs,
 *  breadcrumbs, status bar). Each line keeps its indentation after the gutter. */
interface Gutter {
  lines: string[];
  removed: boolean;
  outside: number;
  header: string[];
  hints: EditorHint[];
  firstLine: number;
}

function stripGutter(lines: readonly string[]): Gutter {
  const numbered = lines.flatMap((l, i) => {
    const m = GUTTER.exec(l);
    return m ? [{ i, n: Number(m[1]), prefix: m[0].length, code: l.length > m[0].length }] : [];
  });
  let counting = 0;
  for (let k = 1; k < numbered.length; k++) if (numbered[k]!.n === numbered[k - 1]!.n + 1) counting++;
  const filled = lines.filter((l) => l.trim()).length;
  if (numbered.length < 3 || counting < (numbered.length - 1) * AGREE || numbered.length < filled * 0.5) {
    return { lines: [...lines], removed: false, outside: 0, header: [], hints: [], firstLine: 1 };
  }
  // Where the code starts: the narrowest gutter among numbered lines whose
  // code starts like code (a misread such as "13 |" must not move it).
  const codeLike = numbered.filter((x) => x.code && /^[\p{L}\p{N}_#"'“”‘’@([{}\]<\/.]/u.test(lines[x.i]!.slice(x.prefix)));
  const column = Math.min(...(codeLike.length ? codeLike : numbered.filter((x) => x.code)).map((x) => x.prefix));
  const first = numbered[0]!.i;
  const last = numbered.at(-1)!.i;
  // A line between two consecutive numbers (6, "Debug", 7) is an editor hint, not code.
  const hint = new Set<number>();
  for (let k = 1; k < numbered.length; k++) {
    if (numbered[k]!.n !== numbered[k - 1]!.n + 1) continue;
    for (let i = numbered[k - 1]!.i + 1; i < numbered[k]!.i; i++) if (lines[i]!.trim()) hint.add(i);
  }
  const cut = (l: string) => {
    const m = GUTTER.exec(l) ?? MISREAD.exec(l);
    if (!m) return l;
    if (m[0].length === l.length) return ""; // only a line number: an empty code line
    // Cut at the code column when what's before it is the gutter plus stray marks.
    if (m[0].length >= column - 1 || !/[\p{L}\p{N}]/u.test(l.slice(m[0].length, column))) return l.slice(column);
    return l;
  };
  const out: string[] = [];
  const hints: EditorHint[] = [];
  // The first line's number: the most common (number − position), so misread numbers don't shift it.
  const offsets = new Map<number, number>();
  for (let i = first; i <= last; i++) {
    const l = lines[i]!;
    if (hint.has(i)) {
      hints.push({ before: out.length, text: l.trim() });
      continue;
    }
    const m = GUTTER.exec(l);
    if (m) offsets.set(Number(m[1]) - out.length, (offsets.get(Number(m[1]) - out.length) ?? 0) + 1);
    out.push(cut(l));
  }
  const [offset] = [...offsets].reduce((best, o) => (o[1] > best[1] ? o : best), [1, 0]);
  return {
    lines: out,
    removed: true,
    outside: lines.slice(0, first).filter((l) => l.trim()).length + lines.slice(last + 1).filter((l) => l.trim()).length + hint.size,
    header: lines.slice(0, first).map((l) => l.trim()).filter(Boolean),
    hints,
    firstLine: Math.max(1, offset),
  };
}

/** Snap indentation that is one space off a common step (OCR spacing is approximate). */
function snapIndent(lines: readonly string[]): { lines: string[]; unit: number | null; snapped: number } {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const left = Math.min(...indents, Infinity);
  const shifted = indents.map((n) => n - (Number.isFinite(left) ? left : 0)).filter((n) => n > 0);
  for (const unit of [4, 2]) {
    const near = shifted.filter((n) => Math.min(n % unit, unit - (n % unit)) <= 1).length;
    if (shifted.length && near >= shifted.length * AGREE) {
      let snapped = 0;
      const out = lines.map((l) => {
        if (!l.trim()) return "";
        const indent = l.length - l.trimStart().length - left;
        const fixed = Math.round(indent / unit) * unit;
        if (fixed !== indent && Math.abs(fixed - indent) <= 1) {
          snapped++;
          return " ".repeat(fixed) + l.trimStart();
        }
        return l.slice(left);
      });
      return { lines: out, unit, snapped };
    }
  }
  return { lines: lines.map((l) => (l.trim() ? l.slice(Number.isFinite(left) ? left : 0) : "")), unit: null, snapped: 0 };
}

export function cleanCode(lines: readonly string[]): CodeCleanup {
  const gutter = stripGutter(lines);
  const indent = snapIndent(gutter.lines);
  // Editors show straight quotes; curly ones in code are OCR misreads.
  const straight = indent.lines.map((l) => l.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'"));
  return {
    lines: straight,
    quotesStraightened: straight.filter((l, i) => l !== indent.lines[i]).length,
    lineNumbersRemoved: gutter.removed,
    linesOutsideCode: gutter.outside,
    indentUnit: indent.unit,
    linesSnapped: indent.snapped,
    header: gutter.header,
    hints: gutter.hints,
    firstLine: gutter.firstLine,
  };
}

/** Unmistakable markers, checked first: auto-detection confuses e.g. Java with TypeScript. */
const MARKERS: [string, RegExp][] = [
  ["java", /\bSystem\.out\.print|\bpublic\s+static\s+void\s+main\b|^\s*import\s+java\./m],
  ["csharp", /\bConsole\.(Write|ReadLine)|^\s*using\s+System\b|\bnamespace\s+\w+\s*[{;]/m],
  ["c", /^\s*#include\s*<(stdio|stdlib|string)\.h>|\bprintf\s*\(/m],
  ["cpp", /^\s*#include\s*<(iostream|vector|string)>|\bstd::/m],
  ["python", /^\s*def\s+\w+\(.*\)\s*:|^\s*(from\s+\w+\s+)?import\s+\w+\s*$|\bprint\(|\belif\b/m],
  ["powershell", /\b(Write-Host|Get-ChildItem|Set-Location|New-Item)\b/],
  ["xml", /^\s*<(!DOCTYPE|html|head|body|div)\b/im],
];

/** The language highlight.js finds most likely, or null when nothing fits well. */
export function detectLanguage(code: string): string | null {
  // JSON: most non-empty lines are `"key": value` pairs or brackets.
  const filled = code.split("\n").filter((l) => l.trim());
  const pairs = filled.filter((l) => /^\s*"[^"]+"\s*:/.test(l)).length;
  if (pairs >= 3 && pairs >= filled.length * 0.5) return "json";
  const marked = MARKERS.find(([, pattern]) => pattern.test(code));
  if (marked) return marked[0];
  const best = hljs.highlightAuto(code, Object.keys(LANGUAGES));
  return best.language && best.relevance >= 5 ? best.language : null;
}

const unescape = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/** JSON only: a lone letter or mark where a brace must be (OCR reads "{" as "t",
 *  "}" as "b"). The file must open with "{" or "["; a lone character that
 *  leaves braces unbalanced closes one. Returns the lines and how many changed. */
export function repairJsonBraces(lines: readonly string[]): { lines: string[]; repaired: number } {
  const out = [...lines];
  let repaired = 0;
  const lone = (l: string) => /^\s*[^\s"{}[\]]{1,2}\s*$/.test(l);
  const first = out.findIndex((l) => l.trim());
  if (first >= 0 && lone(out[first]!) && !/^\s*[{[]/.test(out[first]!)) {
    out[first] = out[first]!.replace(/\S+/, "{");
    repaired++;
  }
  let depth = 0;
  for (const [i, l] of out.entries()) {
    if (i !== first && lone(l) && depth > 0) {
      out[i] = l.replace(/\S+/, "}");
      repaired++;
    }
    for (const c of out[i]!.replace(/"(?:\\.|[^"\\])*"/g, "")) depth += c === "{" || c === "[" ? 1 : c === "}" || c === "]" ? -1 : 0;
  }
  return { lines: out, repaired };
}

/** VS Code's bracket pair colors, by nesting depth. */
const BRACKETS: readonly RGB[] = [[0xff, 0xd7, 0x00], [0xda, 0x70, 0xd6], [0x17, 0x9f, 0xff]];

/** Color brackets outside strings and comments by depth, as VS Code does. */
function colorBrackets(lines: Run[][]): Run[][] {
  let depth = 0;
  return lines.map((runs) =>
    runs.flatMap((run) => {
      if (run.color) return [run];
      return (run.text.match(/[{}[\]()]|[^{}[\]()]+/g) ?? []).map((text): Run => {
        if (/[{[(]/.test(text)) return { text, color: BRACKETS[depth++ % BRACKETS.length] };
        if (/[}\])]/.test(text)) return { text, color: BRACKETS[(depth = Math.max(0, depth - 1)) % BRACKETS.length] };
        return { text };
      });
    }),
  );
}

/** Letters needed before a measured color replaces the theme's. */
const MIN_LETTERS = 6;
/** Straight quotes in place of curly ones, one for one, so offsets still match. */
const straight = (text: string) => text.replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'");

/** The theme with each syntax color replaced by the screenshot's own, where
 *  the screenshot shows enough letters of that kind. Each OCR row is
 *  highlighted on its own to learn which kind every letter is (a JSON key,
 *  a string…); `letterColor` is that letter's measured ink color. Works for
 *  any editor theme: no colors are assumed, only the kinds of token. */
export function measuredTheme(
  rows: readonly (readonly { text: string }[])[],
  language: string | null,
  base: Theme,
  letterColor: (word: { text: string }, index: number) => RGB | undefined,
): { theme: Theme; measured: Slot[] } {
  // Highlight with a probe theme whose colors encode their slot.
  const slots = Object.keys(base.colors) as Slot[];
  const probe: Theme = { ...base, colors: Object.fromEntries(slots.map((s, i) => [s, [i + 1, 0, 0]])) as unknown as Theme["colors"] };
  const samples = new Map<Slot, RGB[]>();
  for (const row of rows) {
    const line = highlightCode(straight(row.map((w) => w.text).join(" ")), language, probe)[0];
    if (!line) continue;
    const kinds: Slot[] = line.runs.flatMap((run) => {
      const slot = run.color && run.color[1] === 0 && run.color[2] === 0 ? slots[run.color[0] - 1] : undefined;
      // Brackets get pair colors, not a slot: leave them out.
      return [...run.text].map(() => (run.color ? slot : "text") as Slot);
    });
    let offset = 0;
    for (const word of row) {
      for (let i = 0; i < word.text.length; i++) {
        const kind = kinds[offset + i];
        const color = letterColor(word, i);
        if (kind && color && /\S/.test(word.text[i]!)) samples.set(kind, [...(samples.get(kind) ?? []), color]);
      }
      offset += word.text.length + 1;
    }
  }
  const median = (ns: number[]) => [...ns].sort((a, b) => a - b)[ns.length >> 1]!;
  const measured = slots.filter((s) => (samples.get(s)?.length ?? 0) >= MIN_LETTERS);
  const colors = { ...base.colors };
  for (const s of measured) {
    const cs = samples.get(s)!;
    colors[s] = [median(cs.map((c) => c[0])), median(cs.map((c) => c[1])), median(cs.map((c) => c[2]))];
  }
  return { theme: { ...base, name: `${base.name}+measured`, colors }, measured };
}

/** Highlight `code` and return one painted line per line, in the theme's colors. */
export function highlightCode(code: string, language: string | null, theme: Theme): PaintedLine[] {
  const html = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : code.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const lines: Run[][] = [[]];
  const scopes: string[] = [];
  for (const [, open, close, text] of html.matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/g)) {
    // "hljs-title function_ invoke__" → "title.function.invoke"
    if (open !== undefined) scopes.push(open.split(" ").map((c) => c.replace(/^hljs-/, "").replace(/_+$/, "")).join("."));
    else if (close) scopes.pop();
    else if (text) {
      // Innermost scope with a color, e.g. a string inside a template.
      const scope = [...scopes].reverse().find((s) => SCOPES[s] !== undefined);
      const slot = scope ? SCOPES[scope]! : "text";
      for (const [i, part] of unescape(text).split("\n").entries()) {
        if (i > 0) lines.push([]);
        if (part) lines.at(-1)!.push(slot === "text" ? { text: part } : { text: part, color: theme.colors[slot] });
      }
    }
  }
  return colorBrackets(lines).map((runs) => ({ runs }));
}
