/** Code screenshots: detect the language and highlight the code with the
 *  course theme, in VS Code's Dark+ colors. */

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

export interface EditorHint {
  /** Index of the code line the hint sits above. */
  before: number;
  text: string;
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

/** Names AIs and people use for a language → the name highlight.js knows. */
const ALIASES: Record<string, keyof typeof LANGUAGES> = {
  js: "javascript", node: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", ps1: "powershell", pwsh: "powershell",
  "c#": "csharp", cs: "csharp", "c++": "cpp", html: "xml", svg: "xml", yml: "yaml", h: "c",
};

/** The highlight.js name for `name` ("JS", "C#", "yml"), or null when it isn't one we highlight. */
export function supportedLanguage(name: string | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return key in LANGUAGES ? key : ALIASES[key] ?? null;
}

/** The quote a line leaves open at its end, or null. */
function openQuote(line: string): string | null {
  let open: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") i++;
    else if (open === null && (c === '"' || c === "'")) open = c;
    else if (c === open) open = null;
  }
  return open;
}

/** Highlight code whose lines may be cut off at the screenshot's edge. A
 *  string cut off mid-line would run on into the next lines and swap every
 *  later key and value, so for highlighting only, each cut-off line's open
 *  string is closed at the edge; the added quote is not drawn. */
export function highlightClipped(lines: readonly string[], clipped: readonly boolean[], language: string | null, theme: Theme): PaintedLine[] {
  const closers = lines.map((l, i) => (clipped[i] ? openQuote(l) : null));
  const painted = highlightCode(lines.map((l, i) => l + (closers[i] ?? "")).join("\n"), language, theme);
  return painted.map((line, i) => {
    if (!closers[i]) return line;
    const runs = [...line.runs];
    const last = runs.at(-1);
    if (last?.text.endsWith(closers[i]!)) runs[runs.length - 1] = { ...last, text: last.text.slice(0, -1) };
    return { ...line, runs: runs.filter((r) => r.text) };
  });
}
