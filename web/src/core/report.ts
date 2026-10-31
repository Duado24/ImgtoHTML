/** A screenshot report: what a strong AI (a ChatGPT or Claude plugin) read in
 *  a screenshot, pasted into ImgtoHTML in place of the local vision model's
 *  answers. The AI reports text and structure, which it reads well; the app
 *  keeps measuring colors and spacing from the image itself, and renders,
 *  checks and reviews as usual.
 *
 *  Version 1, as JSON (boxes on a 0–1000 grid over the whole screenshot,
 *  whatever its size, so the AI never needs the pixel dimensions):
 *
 *    {
 *      "format": "imgtohtml-report", "version": 1,
 *      "kind": "code",                       // terminal | code | interface | diagram
 *      "application": "ide",                 // ide | code-editor | terminal | website | desktop | other
 *      "language": "json",                   // code only, optional
 *      "regions": [
 *        { "id": "files", "type": "sidebar", "parent": null,
 *          "box": { "x": 0, "y": 40, "width": 180, "height": 960 },
 *          "lines": ["EXPLORER", "> docs", "v web"] },
 *        { "id": "code", "type": "code", "parent": null,
 *          "box": { "x": 180, "y": 90, "width": 820, "height": 910 },
 *          "lines": ["{", "  \"name\": \"imgtohtml-web\",", "  \"description\": \"Local screenshot to Canvas HTML app, with a TypeScript client and Nod"],
 *          "cut_off_lines": [3], "unsure_words": ["Nod"] }
 *      ],
 *      "diagram": { "summary": "…", "nodes": [...], "edges": [...] },   // diagram only
 *      "notes": "anything for the designer; never shown on the page"
 *    }
 *
 *  Each line is exactly what the screenshot shows, leading spaces included.
 *  Text that was erased or hidden in the screenshot stays out: the report
 *  never fills it in. Parsing collects every problem at once, so a designer
 *  can send them all back to the AI in one message. */

import { COMPONENTS, APPLICATIONS, checkLayout, type VisionLayout } from "./vision-layout";
import type { Diagram } from "./diagram";
import { KINDS, type Box, type Kind } from "./types";

export const REPORT_FORMAT = "imgtohtml-report";
export const REPORT_VERSION = 1;

/** Limits that keep a pasted report from swamping the page or the server. */
const MAX_CHARS = 1_000_000;
const MAX_REGIONS = 40;
const MAX_LINES = 5_000;
const MAX_LINE_CHARS = 2_000;
const MAX_NODES = 200;
const GRID = 1000;

export interface ReportRegion {
  id: string;
  type: (typeof COMPONENTS)[number];
  parent: string | null;
  /** On the 0–1000 grid; absent = the whole screenshot. */
  box?: Box;
  lines: string[];
  /** 1-based numbers of lines the screenshot cuts off at its edge. */
  cut_off_lines?: number[];
  /** Words the AI isn't sure it read right. */
  unsure_words?: string[];
}

export interface ScreenshotReport {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  kind: Kind;
  application: (typeof APPLICATIONS)[number];
  language?: string;
  regions: ReportRegion[];
  diagram?: Diagram;
  notes?: string;
}

/** One region's text, placed in image pixels, as the job's vision readings are. */
export interface ReportReading {
  box: Box;
  role: string;
  text: string;
}

/** What the rest of the app uses from a report, in image pixels. */
export interface ReportInputs {
  report: ScreenshotReport;
  /** Null when the regions don't form a valid layout (overlaps, a missing parent…); `layoutProblem` says why. */
  layout: VisionLayout | null;
  layoutProblem: string | null;
  readings: ReportReading[];
  diagram: Diagram | null;
  /** Fields the format doesn't know: ignored, but worth telling the designer. */
  warnings: string[];
}

export type ReportResult = { ok: true; value: ReportInputs } | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const TOP_KEYS = ["format", "version", "kind", "application", "language", "regions", "diagram", "notes"];
const REGION_KEYS = ["id", "type", "parent", "box", "lines", "cut_off_lines", "unsure_words"];

/** Accept the JSON as an AI usually hands it over: possibly inside a ```json fence. */
function unwrap(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  return (fenced ? fenced[1]! : text).trim();
}

function checkBox(value: unknown, where: string, problems: string[]): Box | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) { problems.push(`${where}: box must be an object with x, y, width and height`); return undefined; }
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) {
    problems.push(`${where}: box needs numeric x, y, width and height`);
    return undefined;
  }
  const [bx, by, bw, bh] = numbers as number[];
  if (bx! < 0 || by! < 0 || bw! <= 0 || bh! <= 0 || bx! + bw! > GRID + 5 || by! + bh! > GRID + 5) {
    problems.push(`${where}: box must lie on the 0–${GRID} grid (got x ${bx}, y ${by}, width ${bw}, height ${bh})`);
    return undefined;
  }
  return { x: bx!, y: by!, width: bw!, height: bh! };
}

function checkDiagram(value: unknown, problems: string[]): Diagram | undefined {
  if (!isObject(value)) { problems.push("diagram must be an object with summary, nodes and edges"); return undefined; }
  const { summary, nodes, edges } = value;
  if (typeof summary !== "string") problems.push("diagram.summary must be text");
  if (!Array.isArray(nodes) || !nodes.length) { problems.push("diagram.nodes must list at least one node"); return undefined; }
  if (nodes.length > MAX_NODES) { problems.push(`diagram has ${nodes.length} nodes (at most ${MAX_NODES})`); return undefined; }
  if (!Array.isArray(edges)) { problems.push("diagram.edges must be a list (it can be empty)"); return undefined; }
  const ids = new Set<string>();
  for (const [i, n] of nodes.entries()) {
    if (!isObject(n) || typeof n.id !== "string" || typeof n.label !== "string" || typeof n.shape !== "string") {
      problems.push(`diagram.nodes[${i}] needs text id, label and shape`);
    } else if (ids.has(n.id)) problems.push(`diagram.nodes[${i}]: duplicate id "${n.id}"`);
    else ids.add(n.id);
  }
  for (const [i, e] of edges.entries()) {
    if (!isObject(e) || typeof e.from !== "string" || typeof e.to !== "string" || typeof e.label !== "string") {
      problems.push(`diagram.edges[${i}] needs text from, to and label ("" when the arrow has none)`);
    } else if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`diagram.edges[${i}] joins a node that isn't listed ("${e.from}" → "${e.to}")`);
  }
  return value as unknown as Diagram;
}

/** Check a pasted report against format v1 and convert it to image pixels
 *  (`width` × `height`: the screenshot it describes). */
export function parseReport(text: string, width: number, height: number): ReportResult {
  if (text.length > MAX_CHARS) return { ok: false, problems: [`The report is ${text.length} characters (at most ${MAX_CHARS}).`] };
  let value: unknown;
  try { value = JSON.parse(unwrap(text)); }
  catch (error) { return { ok: false, problems: [`The report isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  if (!isObject(value)) return { ok: false, problems: ["The report must be one JSON object."] };

  const problems: string[] = [];
  const warnings: string[] = [];
  if (value.format !== REPORT_FORMAT) problems.push(`format must be "${REPORT_FORMAT}"`);
  if (value.version !== REPORT_VERSION) problems.push(`version must be ${REPORT_VERSION} (got ${JSON.stringify(value.version)})`);
  if (!KINDS.includes(value.kind as Kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`);
  if (!APPLICATIONS.includes(value.application as (typeof APPLICATIONS)[number])) problems.push(`application must be one of ${APPLICATIONS.join(", ")}`);
  if (value.language !== undefined && (typeof value.language !== "string" || value.language.length > 40)) problems.push("language must be a short name such as \"json\" or \"python\"");
  if (value.notes !== undefined && typeof value.notes !== "string") problems.push("notes must be text");
  for (const key of Object.keys(value)) if (!TOP_KEYS.includes(key)) warnings.push(`Ignored unknown field "${key}".`);

  const regions: ReportRegion[] = [];
  if (!Array.isArray(value.regions) || !value.regions.length) problems.push("regions must list at least one region");
  else if (value.regions.length > MAX_REGIONS) problems.push(`${value.regions.length} regions (at most ${MAX_REGIONS})`);
  else {
    const ids = new Set<string>();
    let lineCount = 0;
    for (const [i, r] of value.regions.entries()) {
      const where = `regions[${i}]${isObject(r) && typeof r.id === "string" ? ` ("${r.id}")` : ""}`;
      if (!isObject(r)) { problems.push(`${where} must be an object`); continue; }
      for (const key of Object.keys(r)) if (!REGION_KEYS.includes(key)) warnings.push(`${where}: ignored unknown field "${key}".`);
      if (typeof r.id !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(r.id)) problems.push(`${where}: id must be 1–48 letters, digits, - or _`);
      else if (ids.has(r.id)) problems.push(`${where}: duplicate id`);
      else ids.add(r.id);
      if (!COMPONENTS.includes(r.type as ReportRegion["type"])) problems.push(`${where}: type must be one of ${COMPONENTS.join(", ")}`);
      if (r.parent !== null && r.parent !== undefined && typeof r.parent !== "string") problems.push(`${where}: parent must be another region's id or null`);
      const box = checkBox(r.box, where, problems);
      const lines = r.lines;
      if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) { problems.push(`${where}: lines must be a list of text lines`); continue; }
      lineCount += lines.length;
      const long = lines.findIndex((l) => l.length > MAX_LINE_CHARS);
      if (long >= 0) problems.push(`${where}: line ${long + 1} is longer than ${MAX_LINE_CHARS} characters`);
      if (lines.some((l) => l.includes("\n"))) problems.push(`${where}: put each line in its own string, without \\n inside`);
      const cut = r.cut_off_lines;
      if (cut !== undefined && (!Array.isArray(cut) || !cut.every((n) => Number.isInteger(n) && n >= 1 && n <= lines.length))) {
        problems.push(`${where}: cut_off_lines must be line numbers from 1 to ${lines.length}`);
      }
      const unsure = r.unsure_words;
      if (unsure !== undefined && (!Array.isArray(unsure) || !unsure.every((w) => typeof w === "string"))) problems.push(`${where}: unsure_words must be a list of words`);
      regions.push({
        id: String(r.id), type: r.type as ReportRegion["type"], parent: typeof r.parent === "string" ? r.parent : null,
        ...(box ? { box } : {}), lines: lines as string[],
        ...(Array.isArray(cut) ? { cut_off_lines: cut as number[] } : {}),
        ...(Array.isArray(unsure) ? { unsure_words: unsure as string[] } : {}),
      });
    }
    if (lineCount > MAX_LINES) problems.push(`${lineCount} lines in all (at most ${MAX_LINES})`);
    for (const r of regions) if (r.parent !== null && !ids.has(r.parent)) problems.push(`regions ("${r.id}"): parent "${r.parent}" isn't a listed region`);
  }

  let diagram: Diagram | undefined;
  if (value.diagram !== undefined) diagram = checkDiagram(value.diagram, problems);
  if (value.kind === "diagram" && value.diagram === undefined) problems.push("a diagram report needs a diagram with summary, nodes and edges");
  if (problems.length) return { ok: false, problems };

  const report = { ...(value as unknown as ScreenshotReport), regions };
  const toPixels = (box: Box | undefined): Box => box
    ? { x: box.x * width / GRID, y: box.y * height / GRID, width: box.width * width / GRID, height: box.height * height / GRID }
    : { x: 0, y: 0, width, height };
  // The existing layout checks apply: a broken tree costs the layout, not the text.
  const checked = checkLayout({
    application: report.application,
    components: regions.map((r) => ({ id: r.id, type: r.type, parent: r.parent, box: toPixels(r.box) })),
  }, width, height);
  const readings = regions.filter((r) => r.lines.some((l) => l.trim())).map((r) => ({ box: toPixels(r.box), role: r.type, text: r.lines.join("\n") }));
  return { ok: true, value: { report, layout: checked.layout, layoutProblem: checked.problem, readings, diagram: diagram ?? null, warnings } };
}

/** All of a report's text, in the order the report lists its regions (the
 *  AI's reading order): what it says the screenshot reads, for scoring
 *  against a known transcript. */
export function reportText(report: ScreenshotReport): string {
  return report.regions.flatMap((r) => r.lines).join("\n");
}
