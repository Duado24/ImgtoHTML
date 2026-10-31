/** Diagrams (flowcharts, UML, ER schemas, networks): the structure redrawn as
 *  Canvas-safe HTML from the AI report. Nodes become shaped cards in rows
 *  (the screenshot's rows when the report gives node boxes, otherwise the
 *  flow's steps), each listing the arrows that leave it; a "Text description"
 *  dropdown holds the parts and connections as plain lists for screen
 *  readers. No SVG or absolute positioning: Canvas strips both. */

import { escapeHtml } from "./render";
import type { Box } from "./types";

export interface DiagramNode {
  id: string;
  label: string;
  /** e.g. start, end, process, decision, data, note. */
  shape: string;
  /** Where the node sits, on the report's 0–1000 grid. */
  box?: Box;
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

const P = "margin:0 0 8px;";
const LIST = "margin:0 0 8px;padding-left:24px;";
const TEXT = "#2d3b45";
const MUTED = "#5b6770";

/** Card look per shape; all text stays #2d3b45 or #5b6770, both 4.5:1 or more on these backgrounds. */
const LOOKS: Record<string, { border: string; background: string; radius: string }> = {
  start: { border: "2px solid #2b6cb0", background: "#e8f1fb", radius: "999px" },
  end: { border: "2px solid #2b6cb0", background: "#e8f1fb", radius: "999px" },
  decision: { border: "2px solid #b7791f", background: "#fff7e0", radius: "0.75rem" },
  data: { border: "2px dashed #4a7c59", background: "#eef7ee", radius: "0.75rem" },
  database: { border: "2px solid #4a7c59", background: "#eef7ee", radius: "1.5rem 1.5rem 0.75rem 0.75rem" },
  note: { border: "1px dashed #b7791f", background: "#fffbea", radius: "0.75rem" },
  entity: { border: "2px solid #6b46c1", background: "#f4f0fb", radius: "0.75rem" },
  class: { border: "2px solid #6b46c1", background: "#f4f0fb", radius: "0.75rem" },
};
const PLAIN = { border: "1px solid #8a96a0", background: "#ffffff", radius: "0.75rem" };

/** Rows of node ids. With boxes for every node: the screenshot's own rows,
 *  left to right. Otherwise each node goes one row below the furthest node
 *  that leads to it; arrows that loop back are left out of that count. */
export function diagramRows(diagram: Diagram): string[][] {
  const { nodes, edges } = diagram;
  if (nodes.length && nodes.every((n) => n.box)) {
    const sorted = [...nodes].sort((a, b) => a.box!.y + a.box!.height / 2 - (b.box!.y + b.box!.height / 2));
    const rows: { bottom: number; nodes: DiagramNode[] }[] = [];
    for (const n of sorted) {
      const row = rows.at(-1);
      if (row && n.box!.y + n.box!.height / 2 <= row.bottom) { row.nodes.push(n); row.bottom = Math.max(row.bottom, n.box!.y + n.box!.height); }
      else rows.push({ bottom: n.box!.y + n.box!.height, nodes: [n] });
    }
    return rows.map((r) => r.nodes.sort((a, b) => a.box!.x - b.box!.x).map((n) => n.id));
  }

  const ids = nodes.map((n) => n.id);
  const out = new Map(ids.map((id) => [id, edges.filter((e) => e.from === id && ids.includes(e.to)).map((e) => e.to)]));
  // Depth-first from each node in the report's order; an arrow to a node still being visited loops back.
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const to of out.get(id)!) {
      if (state.get(to) === "open") back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);

  const rank = new Map(ids.map((id) => [id, 0]));
  // Longest path over the forward arrows; at most one pass per node settles it.
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const id of ids) for (const to of out.get(id)!) {
      if (!back.has(`${id}>${to}`) && rank.get(to)! < rank.get(id)! + 1) { rank.set(to, rank.get(id)! + 1); changed = true; }
    }
    if (!changed) break;
  }
  const rows: string[][] = [];
  for (const id of ids) (rows[rank.get(id)!] ??= []).push(id);
  return rows.filter(Boolean);
}

/** The Canvas fragment: summary, the redrawn diagram, and a text-description dropdown. */
export function renderDiagram(diagram: Diagram, label: string, caption?: string | null): string {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  // Connections name a part by its first line (an entity or class by its name); the parts list has the full text.
  const name = (id: string) => {
    const node = byId.get(id);
    const first = (node?.label ?? id).split("\n")[0]!.trim();
    return node && /^(entity|class)$/i.test(node.shape) && first.includes(":") ? first.slice(0, first.indexOf(":")).trim() : first;
  };
  const multiline = (text: string) => text.split(/\n+/).map((l) => escapeHtml(l.trim())).join("<br>");
  const parts = diagram.nodes.map((n) => `        <li>${multiline(n.label)}${n.shape && n.shape !== "process" ? ` (${escapeHtml(n.shape)})` : ""}</li>`);
  const links = diagram.edges.map(
    (e) => `        <li>${escapeHtml(name(e.from))} → ${escapeHtml(name(e.to))}${e.label ? ` (${escapeHtml(e.label)})` : ""}</li>`,
  );

  const rows = diagramRows(diagram);
  const rowOf = new Map(rows.flatMap((r, i) => r.map((id) => [id, i] as const)));
  const card = (node: DiagramNode) => {
    const shape = node.shape.toLowerCase();
    const look = LOOKS[shape] ?? PLAIN;
    const tag = shape && shape !== "process" && shape !== node.label.trim().toLowerCase() ?`<div style="font-size:12px;letter-spacing:0.05em;color:${MUTED};">${escapeHtml(shape.toUpperCase())}</div>` : "";
    // Entities and classes: "Name: a, b, c" → a header with one attribute per line.
    const split = (shape === "entity" || shape === "class") && node.label.includes(":");
    const [head, rest] = split ? [node.label.slice(0, node.label.indexOf(":")), node.label.slice(node.label.indexOf(":") + 1)] : [node.label, ""];
    const members = rest.split(/,|\n/).map((m) => m.trim()).filter(Boolean);
    const body = split
      ? `<div style="font-weight:bold;">${escapeHtml(head.trim())}</div>` +
        (members.length ? `<div style="margin-top:4px;padding-top:4px;border-top:1px solid #8a96a0;text-align:left;">${members.map(escapeHtml).join("<br>")}</div>` : "")
      : `<div style="font-weight:bold;overflow-wrap:anywhere;">${multiline(node.label)}</div>`;
    const arrows = diagram.edges.filter((e) => e.from === node.id).map((e) => {
      const loops = (rowOf.get(e.to) ?? 0) < (rowOf.get(node.id) ?? 0) || e.to === node.id;
      return `<div style="overflow-wrap:anywhere;">${loops ? "↩" : "→"} ${e.label ? `<strong>${escapeHtml(e.label)}:</strong> ` : ""}${escapeHtml(name(e.to))}</div>`;
    });
    const footer = arrows.length ? `<div style="margin-top:6px;padding-top:4px;border-top:1px solid #c7cdd1;font-size:13px;color:${MUTED};text-align:left;">${arrows.join("")}</div>` : "";
    // The outer box keeps a gap around the card even when a row is full.
    return `        <div style="flex:1 1 170px;max-width:292px;min-width:0;box-sizing:border-box;margin:0 auto;padding:6px;">` +
      `<div style="box-sizing:border-box;height:100%;padding:8px 12px;border:${look.border};border-radius:${look.radius};` +
      `background-color:${look.background};color:${TEXT};text-align:center;">${tag}${body}${footer}</div></div>`;
  };
  const drawn = rows.map((row) => `      <div style="display:flex;flex-wrap:wrap;min-width:0;">\n${row.map((id) => card(byId.get(id)!)).join("\n")}\n      </div>`)
    .join(`\n      <div aria-hidden="true" style="text-align:center;color:${MUTED};font-size:20px;line-height:1;margin:0;">↓</div>\n`);

  return (
    `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;min-width:0;margin:0;">\n` +
    `  <div style="max-width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid #c7cdd1;border-radius:0.75rem;color:${TEXT};background-color:#ffffff;font:15px/1.5 Lato,Arial,sans-serif;">\n` +
    `    <p style="${P}"><strong>Diagram:</strong> ${escapeHtml(diagram.summary)}</p>\n` +
    (drawn ? `    <div style="min-width:0;margin:0 0 8px;">\n${drawn}\n    </div>\n` : "") +
    `    <details style="margin:0;border-top:1px solid #c7cdd1;padding-top:8px;">\n` +
    `      <summary style="font-weight:bold;">Text description</summary>\n` +
    (parts.length ? `      <p style="${P}margin-top:8px;"><strong>Parts</strong></p>\n      <ul style="${LIST}">\n${parts.join("\n")}\n      </ul>\n` : "") +
    (links.length ? `      <p style="${P}"><strong>Connections</strong></p>\n      <ul style="${LIST}">\n${links.join("\n")}\n      </ul>\n` : "") +
    "    </details>\n" +
    "  </div>" +
    (caption ? `\n  <p style="margin:10px 0 0;padding:0;color:#202124;font:14px/1.5 Arial,sans-serif;">${escapeHtml(caption)}</p>` : "") +
    "\n</div>"
  );
}
