/** A code screenshot drawn as the editor window it came from: Explorer
 *  sidebar, tab bar, breadcrumb, line numbers and code, in VS Code's dark
 *  colors. Built from what OCR read in each panel, with flex rows and inline
 *  styles only, so Canvas keeps it. The window parts are hidden from screen
 *  readers; they read the code. */

import { rgbHex } from "./colors";
import type { EditorHint } from "./code";
import { lineText, type PaintedLine } from "./paint";
import { escapeHtml } from "./render";

export interface TreeItem {
  depth: number;
  kind: "open" | "closed" | "file";
  name: string;
}

export interface Tab {
  name: string;
  active: boolean;
}

export interface EditorWindow {
  /** Explorer panel lines as OCR read them, or null when there is no sidebar. */
  sidebar: string[] | null;
  /** Editor text above the code: tab bar and breadcrumb. */
  header: string[];
  hints: EditorHint[];
  firstLine: number;
}

const C = {
  editor: "#1f1f1f",
  sidebar: "#181818",
  line: "#303030",
  text: "#cccccc",
  muted: "#858585",
  brace: "#dbb438",
  dot: "#967f4c",
};
const UI = "font-family:'Segoe UI',Arial,sans-serif;font-size:12px;";
const CHEVRON = /^([>›»vV⌄˅Y])\s+(\S.*)$/;
/** Icons OCR reads as stray characters at the start of a tab or crumb. */
const ICON_NOISE = /^(\{\s?\}|[©®@◎▤•·])\s*/;

/** Explorer lines → title and file tree. Text after a wide gap (icons, badges) is dropped. */
export function parseSidebar(lines: readonly string[]): { title: string; items: TreeItem[] } {
  let title = "Explorer";
  const rows = lines.filter((l) => l.trim()).map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim().split(/\s{3,}/)[0]! }));
  const items: { indent: number; kind: TreeItem["kind"]; name: string }[] = [];
  for (const row of rows) {
    if (/^explorer\b/i.test(row.text)) {
      title = row.text.replace(/\s*[•.·]{2,}.*$/, "");
      continue;
    }
    const m = CHEVRON.exec(row.text);
    if (m) items.push({ indent: row.indent, kind: /[>›»]/.test(m[1]!) ? "closed" : "open", name: m[2]! });
    else items.push({ indent: row.indent, kind: "file", name: row.text });
  }
  const left = Math.min(...items.map((i) => i.indent), Infinity);
  return { title, items: items.map((i) => ({ depth: Math.round((i.indent - left) / 2), kind: i.kind, name: i.name })) };
}

const isCrumbs = (line: string) => /\s[>›]\s|\s[>›]$/.test(line);

/** Tab bar line → tabs; the one with a close mark (X, ×) is active. */
export function parseTabs(line: string): Tab[] {
  return line
    .split(/\s{3,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const active = /\s[Xx×]$/.test(t);
      return { name: t.replace(/\s[Xx×]$/, "").replace(ICON_NOISE, "").trim(), active };
    })
    .filter((t) => t.name);
}

export function parseCrumbs(line: string): string[] {
  return line.split(/\s*[>›]\s*/).map((p) => p.replace(ICON_NOISE, "").trim()).filter(Boolean);
}

const fileIcon = (name: string) =>
  /\.json$|json$/i.test(name) ? `<span style="color:${C.brace};">{ }</span>` : /\./.test(name) || /^preview/i.test(name) ? "▤" : "◎";

function sidebarCell(lines: readonly string[]): string {
  const { title, items } = parseSidebar(lines);
  const rows = items.map((item) => {
    const mark = item.kind === "open" ? "⌄" : item.kind === "closed" ? "›" : "&nbsp;";
    const guide = item.depth > 0 ? `border-left:1px solid ${C.line};` : "";
    return `          <div style="padding:0 8px 0 ${8 + item.depth * 12}px;${guide}white-space:pre-wrap;overflow-wrap:anywhere;">` +
      `<span style="display:inline-block;width:14px;color:#aaaaaa;">${mark}</span>${escapeHtml(item.name)}</div>`;
  });
  return (
    `      <div aria-hidden="true" style="flex:0 1 150px;min-width:135px;box-sizing:border-box;background-color:${C.sidebar};border-right:1px solid ${C.line};padding:0;">\n` +
    `        <div style="padding:7px 10px;${UI}color:#e1e1e1;">${escapeHtml(title)}<span style="float:right;color:#a0a0a0;">•••</span></div>\n` +
    `        <div style="padding:2px 0 10px;${UI}line-height:1.85;color:${C.text};">\n${rows.join("\n")}\n        </div>\n` +
    "      </div>\n"
  );
}

function headerHtml(header: readonly string[]): string {
  const crumbsLine = header.find(isCrumbs);
  const tabsLine = header.find((l) => l !== crumbsLine);
  let html = "";
  if (tabsLine) {
    const tabs = parseTabs(tabsLine).map((t) =>
      `<div style="min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;padding:7px 12px;border-right:1px solid ${C.line};` +
      (t.active ? `background-color:${C.editor};color:#eeeeee;border-top:1px solid #777777;"` : `color:${C.muted};"`) +
      `>${fileIcon(t.name)}&nbsp;&nbsp;${t.active ? `<em>${escapeHtml(t.name)}</em>&nbsp;&nbsp;×` : escapeHtml(t.name)}</div>`,
    );
    html += `        <div aria-hidden="true" style="display:flex;flex-wrap:wrap;min-width:0;background-color:${C.sidebar};border-bottom:1px solid ${C.line};${UI}">${tabs.join("")}</div>\n`;
  }
  if (crumbsLine) {
    const crumbs = parseCrumbs(crumbsLine).map((c) => (/json$/i.test(c) ? `${fileIcon(c)}&nbsp;${escapeHtml(c)}` : escapeHtml(c)));
    html += `        <div aria-hidden="true" style="padding:4px 14px;white-space:pre-wrap;overflow-wrap:anywhere;${UI}color:#b0b0b0;">${crumbs.join("&nbsp;&nbsp;›&nbsp;&nbsp;")}</div>\n`;
  }
  return html;
}

/** `backgrounds`: per code line, a background that differs from the panel's
 *  (the current line, a selection), or undefined. */
export function codeRows(lines: readonly PaintedLine[], hints: readonly EditorHint[], firstLine: number, inherited: string, decorateHints = true, gutterWidth = 38, gutterPadding = 14, backgrounds: readonly (string | undefined)[] = []): string {
  const number = (n: string) => `<div aria-hidden="true" style="flex:0 0 ${gutterWidth}px;box-sizing:border-box;text-align:right;padding:0 ${gutterPadding}px 0 0;color:${decorateHints ? C.muted : inherited};">${n}</div>`;
  const rows: string[] = [];
  lines.forEach((line, i) => {
    for (const hint of hints.filter((h) => h.before === i)) {
      rows.push(`          <div aria-hidden="true" style="display:flex;min-width:0;">${number("")}<div style="flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;${UI}font-size:11px;color:${decorateHints ? "#a9a9a9" : inherited};">${decorateHints ? "▷ " : ""}${escapeHtml(decorateHints ? hint.text.replace(/^[\u25b7>D]\s*(?=Debug)/, "") : hint.text)}</div></div>`);
    }
    const body = lineText(line)
      ? line.runs.map((r) => (r.color && rgbHex(r.color) !== inherited ? `<span style="color:${rgbHex(r.color)};">${escapeHtml(r.text)}</span>` : escapeHtml(r.text))).join("")
      : "";
    rows.push(`          <div style="display:flex;min-width:0;${backgrounds[i] ? `background-color:${backgrounds[i]};` : ""}">${number(String(firstLine + i))}<div style="flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;">${body || "<br>"}</div></div>`);
  });
  return rows.join("\n");
}

/** The whole window as a Canvas fragment. */
export function renderEditorWindow(lines: readonly PaintedLine[], window: EditorWindow, text: string, label: string, caption?: string | null): string {
  const code =
    `        <div style="min-width:0;padding:4px 0 14px;font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.5;color:${text};">\n` +
    `${codeRows(lines, window.hints, window.firstLine, text)}\n        </div>\n`;
  const editorCell =
    `      <div style="flex:1 1 520px;min-width:280px;max-width:100%;padding:0;background-color:${C.editor};">\n${headerHtml(window.header)}${code}      </div>\n`;
  return (
    `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;min-width:0;margin:0;">\n` +
    `  <div style="display:flex;flex-wrap:wrap;width:100%;box-sizing:border-box;overflow:hidden;border:1px solid #2b2b2b;border-radius:0.75rem;background-color:${C.editor};color:${text};">\n` +
    `${window.sidebar ? sidebarCell(window.sidebar) : ""}${editorCell}  </div>` +
    (caption ? `\n  <p style="margin:10px 0 0;padding:0;color:#202124;font:14px/1.5 Arial,sans-serif;">${escapeHtml(caption)}</p>` : "") +
    "\n</div>"
  );
}
