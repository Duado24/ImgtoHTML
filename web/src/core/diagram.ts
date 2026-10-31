/** Diagrams (flowcharts, UML, ER schemas, networks): an accessible text
 *  version of what the picture shows, from the AI report, written for the
 *  student reading it in Canvas. The screenshot is uploaded to Canvas as an
 *  image; this "Diagram Description" dropdown (closed by default) goes under
 *  it. */

import { escapeHtml } from "./render";

export interface DiagramNode {
  id: string;
  label: string;
  /** e.g. heading, start, end, process, decision, data, note. */
  shape: string;
  /** The id of the heading this node sits under. */
  group?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** Text on the arrow ("yes", "no", "calls"), or "". */
  label: string;
}

export interface Diagram {
  /** One to three plain sentences: what the diagram teaches. */
  summary: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const P = "margin:0 0 8px;";
const LIST = "margin:0 0 8px;padding-left:24px;";
/** Shapes worth naming to a student; the rest ("note", "cloud", "process"…) are drawing details. */
const SHAPE_WORDS: Record<string, string> = { decision: "a yes/no question" };

/** The Canvas fragment: a closed dropdown with the summary, the parts (under
 *  their headings) and every connection, in words a screen reader reads well.
 *  Parts without a label are left out, and so are connections to them. */
export function renderDiagram(diagram: Diagram, caption?: string | null): string {
  const nodes = diagram.nodes.filter((n) => n.label.trim());
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Connections name a part by its first line; the parts list has the full text.
  const name = (id: string) => byId.get(id)!.label.trim().split("\n")[0]!.trim();
  const multiline = (text: string) => text.trim().split(/\n+/).map((l) => escapeHtml(l.trim())).join("<br>");
  const item = (n: DiagramNode) => {
    const shape = SHAPE_WORDS[n.shape.toLowerCase()];
    return `    <li>${multiline(n.label)}${shape ? ` (${shape})` : ""}</li>`;
  };
  const list = (items: readonly DiagramNode[]) => `  <ul style="${LIST}">\n${items.map(item).join("\n")}\n  </ul>\n`;

  // Headings become small titles with their parts listed under them.
  const headings = nodes.filter((n) => n.shape.toLowerCase() === "heading");
  const parts = nodes.filter((n) => n.shape.toLowerCase() !== "heading");
  const under = (h: DiagramNode | null) => parts.filter((n) => (h ? n.group === h.id : !n.group || !headings.some((g) => g.id === n.group)));
  const sections = [
    ...headings.map((h) => `  <p style="${P}"><strong>${multiline(h.label)}</strong></p>\n${under(h).length ? list(under(h)) : ""}`),
    ...(under(null).length ? [`  <p style="${P}"><strong>${headings.length ? "Other parts" : "Parts"}</strong></p>\n${list(under(null))}`] : []),
  ];

  const links = diagram.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map(
    (e) => `    <li>From ${escapeHtml(name(e.from))} to ${escapeHtml(name(e.to))}${e.label ? `, labeled “${escapeHtml(e.label)}”` : ""}</li>`,
  );
  return (
    `<details style="max-width:100%;box-sizing:border-box;margin:0;padding:12px 16px;border:1px solid #c7cdd1;border-radius:0.75rem;color:#2d3b45;background-color:#ffffff;font:15px/1.5 Lato,Arial,sans-serif;">\n` +
    `  <summary style="font-weight:bold;">Diagram Description</summary>\n` +
    `  <p style="margin:8px 0 8px;">${escapeHtml(diagram.summary)}</p>\n` +
    (sections.length ? sections.join("") : "") +
    (links.length ? `  <p style="${P}"><strong>Arrows and lines</strong></p>\n  <ul style="${LIST}">\n${links.join("\n")}\n  </ul>\n` : "") +
    "</details>" +
    (caption ? `\n<p style="margin:10px 0 0;padding:0;color:#202124;font:14px/1.5 Arial,sans-serif;">${escapeHtml(caption)}</p>` : "")
  );
}
