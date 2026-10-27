/** Diagrams (flowcharts, framework maps): an accessible text version of
 *  what the picture shows, read by the vision model. Canvas can't embed
 *  the screenshot from an HTML fragment, so the image is uploaded to Canvas
 *  separately and this description goes with it. Labels the OCR didn't see
 *  are listed for review, since the vision model may misread them. */

import { escapeHtml } from "./render";

export interface DiagramNode {
  id: string;
  label: string;
  /** e.g. start, end, process, decision, data, note. */
  shape: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** Text on the arrow ("yes", "no", "calls"), or "". */
  label: string;
}

export interface Diagram {
  /** One or two sentences: what the diagram is about. */
  summary: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Node labels with a word the OCR didn't find anywhere in the image. */
export function unconfirmedLabels(diagram: Diagram, ocrText: string): string[] {
  const seen = new Set(words(ocrText));
  return diagram.nodes.map((n) => n.label).filter((label) => words(label).some((w) => !seen.has(w)));
}

const P = "margin:0 0 8px;";
const LIST = "margin:0 0 8px;padding-left:24px;";

/** The Canvas fragment: summary, the steps or parts, and every connection. */
export function renderDiagram(diagram: Diagram, label: string, caption?: string | null): string {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  // Connections name a part by its first line; the parts list has the full text.
  const name = (id: string) => (byId.get(id)?.label ?? id).split("\n")[0]!.trim();
  const multiline = (text: string) => text.split(/\n+/).map((l) => escapeHtml(l.trim())).join("<br>");
  const parts = diagram.nodes.map((n) => `      <li>${multiline(n.label)}${n.shape && n.shape !== "process" ? ` (${escapeHtml(n.shape)})` : ""}</li>`);
  const links = diagram.edges.map(
    (e) => `      <li>${escapeHtml(name(e.from))} → ${escapeHtml(name(e.to))}${e.label ? ` (${escapeHtml(e.label)})` : ""}</li>`,
  );
  return (
    `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;min-width:0;margin:0;">\n` +
    `  <div style="max-width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid #c7cdd1;border-radius:6px;color:#2d3b45;background-color:#ffffff;font:15px/1.5 Lato,Arial,sans-serif;">\n` +
    `    <p style="${P}"><strong>Diagram description:</strong> ${escapeHtml(diagram.summary)}</p>\n` +
    (parts.length ? `    <p style="${P}"><strong>Parts</strong></p>\n    <ul style="${LIST}">\n${parts.join("\n")}\n    </ul>\n` : "") +
    (links.length ? `    <p style="${P}"><strong>Connections</strong></p>\n    <ul style="${LIST}">\n${links.join("\n")}\n    </ul>\n` : "") +
    "  </div>" +
    (caption ? `\n  <p style="margin:10px 0 0;padding:0;color:#202124;font:14px/1.5 Arial,sans-serif;">${escapeHtml(caption)}</p>` : "") +
    "\n</div>"
  );
}
