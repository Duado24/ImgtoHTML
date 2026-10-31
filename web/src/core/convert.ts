/** From an AI report to the Canvas HTML fragment, its plain-text transcript
 *  and what the designer should check. Runs in the browser: nothing is
 *  uploaded anywhere. */

import { checkCanvasSafe, type CanvasIssue } from "./canvas";
import { detectLanguage, highlightClipped, supportedLanguage } from "./code";
import { rgbHex } from "./colors";
import { renderDiagram, type Diagram } from "./diagram";
import { renderEditorWindow } from "./editor-window";
import { plainLines } from "./paint";
import { renderPanels, withCutOff, type ColorChange } from "./panels";
import { learnedUsernames, sanitizeText } from "./privacy";
import { render } from "./render";
import type { ReportRegion, ScreenshotReport } from "./report";
import { colorRoles } from "./terminal";
import { CODE_THEME, TERMINAL_THEME } from "./theme";
import type { Kind } from "./types";

export interface ConvertOptions {
  /** What a screen reader announces before the content; a default is made from the report. */
  label?: string;
  /** A visible note under the box. */
  caption?: string;
  /** Code: draw the editor window (explorer, tabs, line numbers) when the report has one. Default true. */
  editorWindow?: boolean;
}

export interface OutputFile {
  name: string;
  mime: string;
  content: string;
}

/** One thing for the designer to check against their screenshot. */
export interface Check {
  region: string;
  /** "Code", "Sidebar", "Dialog"… */
  title: string;
  /** The region's lines as the page shows them (masked, cut-off lines ending in …). */
  lines: string[];
  /** Words the AI wasn't sure about that still appear in the lines. */
  unsure: string[];
  /** 1-based line numbers cut off at the screenshot's edge. */
  cutOff: number[];
}

export type Renderer = "terminal" | "code" | "editor-window" | "panels" | "diagram";

export interface ConvertResult {
  kind: Kind;
  renderer: Renderer;
  label: string;
  caption: string | null;
  html: string;
  /** The text, line by line, as the page shows it. */
  transcript: string;
  canvasIssues: CanvasIssue[];
  /** Text colors changed so they reach 4.5:1 on their background. */
  contrastChanges: ColorChange[];
  checks: Check[];
  /** User names found in home-folder paths and masked as "username". */
  maskedNames: number;
  /** The AI's notes for the designer; never on the page. */
  notes: string | null;
  htmlFile: OutputFile;
  transcriptFile: OutputFile;
}

const KIND_NAMES: Record<Kind, string> = { terminal: "Terminal", code: "Code", diagram: "Diagram", interface: "Screen" };
const TITLES: Record<ReportRegion["type"], string> = {
  sidebar: "Sidebar", editor: "Editor", tabs: "Tabs", breadcrumbs: "File path", code: "Code", menu: "Menu",
  toolbar: "Toolbar", terminal: "Terminal", content: "Content", container: "Window",
};
/** Longest label made from the report's first line. */
const LABEL_CHARS = 90;

/** Mask user names everywhere in the report: lines, unsure words and the diagram. */
function masked(report: ScreenshotReport): { report: ScreenshotReport; names: number } {
  const names = learnedUsernames([...report.regions.flatMap((r) => r.lines), ...(report.diagram?.nodes.map((n) => n.label) ?? [])]);
  const clean = (text: string) => sanitizeText(text, names);
  const diagram: Diagram | undefined = report.diagram && {
    summary: clean(report.diagram.summary),
    nodes: report.diagram.nodes.map((n) => ({ ...n, label: clean(n.label) })),
    edges: report.diagram.edges.map((e) => ({ ...e, label: clean(e.label) })),
  };
  return {
    report: {
      ...report,
      regions: report.regions.map((r) => ({ ...r, lines: r.lines.map(clean), ...(r.unsure_words ? { unsure_words: r.unsure_words.map(clean) } : {}) })),
      ...(diagram ? { diagram } : {}),
    },
    names: names.size,
  };
}

/** What a screen reader announces: the kind, then the first line of text. */
function defaultLabel(report: ScreenshotReport): string {
  const language = supportedLanguage(report.language);
  const kind = report.kind === "code" && language ? `${language === "json" ? "JSON" : language[0]!.toUpperCase() + language.slice(1)} code` : KIND_NAMES[report.kind];
  const first = report.kind === "diagram" ? report.diagram?.summary : report.regions.flatMap((r) => r.lines).find((l) => l.trim());
  const text = first?.trim().replace(/\s+/g, " ") ?? "";
  return text ? `${kind}: ${text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text}` : kind;
}

/** A file name stem from the label: letters, digits, - and _. */
const stemOf = (label: string) => label.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "screenshot";

const ofType = (report: ScreenshotReport, ...types: ReportRegion["type"][]) => report.regions.filter((r) => types.includes(r.type));

/** The editor window's tab line, with the open file marked as editor-window.ts expects (3 spaces apart, "×" on the active tab). */
function tabLine(tabs: ReportRegion | undefined, crumbs: string | undefined, file: string | undefined): string | undefined {
  if (!tabs) return undefined;
  const names = (tabs.lines.length === 1 ? tabs.lines[0]!.split(/\s{2,}/) : tabs.lines).map((t) => t.trim()).filter(Boolean);
  if (!names.length) return undefined;
  const lastCrumb = crumbs?.split(/\s*[>›]\s*/).map((p) => p.trim()).filter((p) => p && !/^\.{3}|…$/.test(p)).at(-1);
  const active = names.find((n) => n === file || n === lastCrumb) ?? names[0];
  return names.map((n) => (n === active ? `${n} ×` : n)).join("   ");
}

export function convert(source: ScreenshotReport, options: ConvertOptions = {}): ConvertResult {
  const { report, names } = masked(source);
  const label = options.label?.trim() || defaultLabel(report);
  const caption = options.caption?.trim() || null;
  let renderer: Renderer;
  let html: string;
  let changes: ColorChange[] = [];
  let shown: ReportRegion[];

  if (report.kind === "diagram" && report.diagram) {
    renderer = "diagram";
    html = renderDiagram(report.diagram, label, caption);
    shown = report.regions;
  } else if (report.kind === "terminal") {
    shown = ofType(report, "terminal");
    if (!shown.length) shown = report.regions;
    renderer = "terminal";
    const lines = shown.flatMap((r) => withCutOff(r.lines, r.cut_off_lines));
    html = render(colorRoles(plainLines(lines), TERMINAL_THEME), label, TERMINAL_THEME.background, TERMINAL_THEME.colors.text, caption);
  } else if (report.kind === "code") {
    shown = ofType(report, "code");
    if (!shown.length) shown = ofType(report, "editor");
    if (!shown.length) shown = report.regions;
    const lines = shown.flatMap((r) => r.lines);
    const cut = shown.flatMap((r) => r.lines.map((_, i) => (r.cut_off_lines ?? []).includes(i + 1)));
    const language = supportedLanguage(report.language) ?? detectLanguage(lines.join("\n"));
    const painted = highlightClipped(withCutOff(lines, cutNumbers(shown)), cut, language, CODE_THEME);
    const sidebar = ofType(report, "sidebar")[0];
    const crumbs = ofType(report, "breadcrumbs")[0]?.lines.find((l) => l.trim());
    const tabs = tabLine(ofType(report, "tabs")[0], crumbs, undefined);
    if (options.editorWindow !== false && (sidebar || tabs || crumbs)) {
      renderer = "editor-window";
      html = renderEditorWindow(painted, {
        sidebar: sidebar ? sidebar.lines : null,
        header: [tabs, crumbs].filter((l): l is string => !!l),
        hints: [],
        firstLine: shown[0]?.first_line ?? 1,
      }, rgbHex(CODE_THEME.colors.text), label, caption);
      shown = [...(sidebar ? [sidebar] : []), ...ofType(report, "tabs", "breadcrumbs"), ...shown];
    } else {
      renderer = "code";
      html = render(painted, label, CODE_THEME.background, CODE_THEME.colors.text, caption);
    }
  } else {
    renderer = "panels";
    ({ html, changes } = renderPanels(report.regions, report.application, label, caption));
    shown = report.regions;
  }

  const transcript = report.kind === "diagram" && report.diagram
    ? [report.diagram.summary, ...report.regions.flatMap((r) => r.lines)].join("\n")
    : shown.flatMap((r) => withCutOff(r.lines, r.cut_off_lines)).join("\n");
  const checks: Check[] = shown.flatMap((r) => {
    const lines = withCutOff(r.lines, r.cut_off_lines);
    const text = lines.join("\n");
    const unsure = [...new Set(r.unsure_words ?? [])].filter((w) => w && text.includes(w));
    const cutOff = r.cut_off_lines ?? [];
    return unsure.length || cutOff.length ? [{ region: r.id, title: TITLES[r.type], lines, unsure, cutOff }] : [];
  });
  const stem = stemOf(label);
  return {
    kind: report.kind, renderer, label, caption, html, transcript,
    canvasIssues: checkCanvasSafe(html),
    contrastChanges: changes,
    checks,
    maskedNames: names,
    notes: report.notes?.trim() || null,
    htmlFile: { name: `Media_${stem}.html`, mime: "text/html", content: html },
    transcriptFile: { name: `${stem}_transcript.txt`, mime: "text/plain", content: transcript },
  };
}

/** Cut-off line numbers of several regions, counted through their joined lines. */
function cutNumbers(regions: readonly ReportRegion[]): number[] {
  let offset = 0;
  return regions.flatMap((r) => {
    const numbers = (r.cut_off_lines ?? []).map((n) => n + offset);
    offset += r.lines.length;
    return numbers;
  });
}
