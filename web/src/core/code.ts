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
  attr: "cyan",
  "selector-class": "yellow",
  "selector-tag": "blue",
  attribute: "cyan",
  variable: "cyan",
  "template-variable": "cyan",
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
}

const GUTTER = /^\s*(\d{1,4})(\s+|$)/;
/** A misread line number ("Bf" for 8, "i." for 14): a short token before the code column. */
const MISREAD = /^\s*\S{1,4}(\s+|$)/;
/** Share of lines that must agree before a fix is applied. */
const AGREE = 0.6;

/** Remove gutter line numbers when the numbered lines mostly count up by one
 *  (OCR misreads some), and the editor lines above and below them (tabs,
 *  breadcrumbs, status bar). Each line keeps its indentation after the gutter. */
function stripGutter(lines: readonly string[]): { lines: string[]; removed: boolean; outside: number } {
  const numbered = lines.flatMap((l, i) => {
    const m = GUTTER.exec(l);
    return m ? [{ i, n: Number(m[1]), prefix: m[0].length, code: l.length > m[0].length }] : [];
  });
  let counting = 0;
  for (let k = 1; k < numbered.length; k++) if (numbered[k]!.n === numbered[k - 1]!.n + 1) counting++;
  const filled = lines.filter((l) => l.trim()).length;
  if (numbered.length < 3 || counting < (numbered.length - 1) * AGREE || numbered.length < filled * 0.5) {
    return { lines: [...lines], removed: false, outside: 0 };
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
  return {
    lines: lines.slice(first, last + 1).flatMap((l, k) => (hint.has(first + k) ? [] : [cut(l)])),
    removed: true,
    outside: lines.slice(0, first).filter((l) => l.trim()).length + lines.slice(last + 1).filter((l) => l.trim()).length + hint.size,
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
  return lines.map((runs) => ({ runs }));
}
