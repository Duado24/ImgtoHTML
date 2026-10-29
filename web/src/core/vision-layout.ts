import { dominantColor, rgbHex } from "./colors";
import { layoutWords } from "./layout";
import { escapeHtml } from "./render";
import type { Box, OcrWord, Pixels } from "./types";

export const COMPONENTS = ["sidebar", "editor", "tabs", "breadcrumbs", "code", "menu", "toolbar", "terminal", "content", "container"] as const;
export const APPLICATIONS = ["ide", "code-editor", "terminal", "website", "desktop", "other"] as const;
export interface LayoutComponent { id: string; type: typeof COMPONENTS[number]; parent: string | null; box: Box }
export interface VisionLayout { application: typeof APPLICATIONS[number]; components: LayoutComponent[] }

/** What the vision model answered for one layout request, and why it was rejected (null: accepted). */
export interface LayoutAttempt { output: unknown; problem: string | null }
export interface LayoutDetection { layout: VisionLayout | null; attempts: LayoutAttempt[] }

/** Qwen3-VL places boxes on a 0–1000 grid over the whole image, whatever its
 *  size; scale them to source pixels. Anything that isn't a box is left as is. */
export function fromNormalized(value: unknown, width: number, height: number): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as VisionLayout).components)) return value;
  const v = value as VisionLayout;
  const scale = (box: Box | undefined) => box && typeof box === "object"
    ? { x: box.x * width / 1000, y: box.y * height / 1000, width: box.width * width / 1000, height: box.height * height / 1000 }
    : box;
  return { ...v, components: v.components.map((c) => (c && typeof c === "object" ? { ...c, box: scale(c.box) } : c)) };
}

/** Untrusted model geometry is normalized to source pixels. Broken trees are
 *  rejected, with the first reason found. */
export function checkLayout(value: unknown, width: number, height: number): { layout: VisionLayout; problem: null } | { layout: null; problem: string } {
  const fail = (problem: string) => ({ layout: null, problem });
  if (!value || typeof value !== "object") return fail("not a JSON object");
  const v = value as VisionLayout;
  if (!APPLICATIONS.includes(v.application)) return fail(`unknown application ${JSON.stringify(v.application)}`);
  if (!Array.isArray(v.components) || !v.components.length) return fail("no components");
  if (v.components.length > 40) return fail(`${v.components.length} components (at most 40)`);
  const ids = new Set<string>();
  const components: LayoutComponent[] = [];
  for (const c of v.components) {
    if (!c || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(c.id)) return fail(`invalid component id ${JSON.stringify(c?.id)}`);
    if (ids.has(c.id)) return fail(`duplicate id ${c.id}`);
    if (!COMPONENTS.includes(c.type)) return fail(`${c.id}: unknown type ${JSON.stringify(c.type)}`);
    if (!c.box) return fail(`${c.id}: no box`);
    const { x, y, width: w, height: h } = c.box;
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0) return fail(`${c.id}: invalid box`);
    if (x >= width || y >= height) return fail(`${c.id}: box starts outside the ${width}×${height} image`);
    ids.add(c.id);
    components.push({ id: c.id, type: c.type, parent: c.parent, box: { x, y, width: Math.min(w, width - x), height: Math.min(h, height - y) } });
  }
  for (const c of components) {
    const seen = new Set([c.id]);
    let p = c.parent;
    while (p !== null) {
      if (seen.has(p)) return fail(`${c.id}: parent cycle`);
      seen.add(p);
      const parent = components.find((n) => n.id === p);
      if (!parent) return fail(`${c.id}: missing parent ${p}`);
      const b = parent.box, a = c.box;
      if (a.x < b.x - 3 || a.y < b.y - 3 || a.x + a.width > b.x + b.width + 3 || a.y + a.height > b.y + b.height + 3) return fail(`${c.id}: outside its parent ${parent.id}`);
      p = parent.parent;
    }
  }
  // Overlapping siblings cannot be represented safely by flow layout.
  for (const a of components) for (const b of components) {
    if (a.id >= b.id || a.parent !== b.parent) continue;
    const overlapX = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
    const overlapY = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
    if (overlapX > 3 && overlapY > 3) return fail(`siblings ${a.id} and ${b.id} overlap`);
  }
  return { layout: { application: v.application, components }, problem: null };
}

export function validateLayout(value: unknown, width: number, height: number): VisionLayout | null {
  return checkLayout(value, width, height).layout;
}

const contains = (b: Box, w: OcrWord) => w.x + w.width / 2 >= b.x && w.x + w.width / 2 < b.x + b.width && w.y + w.height / 2 >= b.y && w.y + w.height / 2 < b.y + b.height;

/** Each word has exactly one owner; no model-generated text reaches HTML. */
export function assignLayoutWords(layout: VisionLayout, words: readonly OcrWord[]): Map<string, OcrWord[]> {
  const assigned = new Map<string, OcrWord[]>();
  for (const w of words) {
    const owner = layout.components.filter((c) => contains(c.box, w)).sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
    const id = owner?.id ?? "\0";
    assigned.set(id, [...(assigned.get(id) ?? []), w]);
  }
  return assigned;
}

/** What `paint` draws for some words: HTML, and optionally their text lines. */
type Painted = string | { html: string; lines: string[] };
interface Drawn { html: string; lines: string[]; words: OcrWord[] }
/** Side-by-side items this short (text lines each) read row by row across them. */
const SHORT = 3;

/** Table columns survive conservative Canvas CSS allowlists. Narrow pages shrink the
 *  columns and cut off long lines at their panel edge: no scrollbar.
 *  `lines`, when given, receives the text in reading order: side-by-side
 *  items of at most SHORT lines each (a name beside a badge, a row of cards)
 *  read row by row across them; taller ones (a sidebar beside an editor)
 *  one after the other. */
export function renderLayout(layout: VisionLayout, words: readonly OcrWord[], width: number, label: string, caption: string | null, paint: (words: OcrWord[], box: Box, component?: LayoutComponent) => Painted, pixels?: Pixels, lines?: string[]): string {
  const assigned = assignLayoutWords(layout, words);
  const drawn = (p: Painted, ws: OcrWord[]): Drawn => (typeof p === "string" ? { html: p, lines: [], words: ws } : { ...p, words: ws });
  const nothing: Drawn = { html: "", lines: [], words: [] };
  // A component's children, plus blocks of its own words that fall outside
  // them, each placed where it sits: a word beside a child shares its row,
  // a word below it comes after it.
  type Item = { box: Box; component: LayoutComponent } | { box: Box; words: OcrWord[] };
  function group(children: LayoutComponent[], loose: readonly OcrWord[], parent?: LayoutComponent): Drawn {
    const items: Item[] = [...children.map((c) => ({ box: c.box, component: c })), ...textBlocks(loose, children).map((ws) => ({ box: bounds(ws), words: ws }))];
    if (!items.length) return nothing;
    const sorted = items.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    // Partition into horizontal bands. Overlapping vertical ranges share a row.
    const bands: Item[][] = [];
    for (const c of sorted) {
      const band = bands[bands.length - 1];
      if (band && c.box.y < Math.max(...band.map((n) => n.box.y + n.box.height)) - 3) band.push(c);
      else bands.push([c]);
    }
    const draw = (item: Item): Drawn => ("component" in item ? node(item.component) : drawn(paint(item.words, item.box, parent), item.words));
    const parts = bands.map((band): Drawn => {
      band.sort((a, b) => a.box.x - b.box.x);
      const cells = band.map(draw);
      if (band.length === 1) return cells[0]!;
      const total = band.reduce((s, c) => s + c.box.width, 0);
      const all = cells.flatMap((c) => c.words);
      const short = cells.every((c) => c.lines.filter((l) => l.trim()).length <= SHORT);
      return {
        html: '<table role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse;border:none;"><tbody><tr>' + band.map((c, i) => `<td style="width:${100 * c.box.width / total}%;vertical-align:top;padding:0;border:none;">${cells[i]!.html}</td>`).join("") + '</tr></tbody></table>',
        lines: short ? layoutWords(all).lines : cells.flatMap((c) => c.lines),
        words: all,
      };
    });
    return { html: parts.map((p) => p.html).join(""), lines: parts.flatMap((p) => p.lines), words: parts.flatMap((p) => p.words) };
  }
  function node(c: LayoutComponent): Drawn {
    const own = assigned.get(c.id) ?? [];
    const children = layout.components.filter((n) => n.parent === c.id);
    // Without children, the component's words are its content; with them,
    // they're placed among the children.
    const body = children.length ? group(children, own, c) : own.length ? drawn(paint(own, c.box, c), own) : nothing;
    return { ...body, html: `<div id="layout-${c.id}" style="min-width:0;overflow:hidden;${pixels ? `background-color:${rgbHex(dominantColor(pixels, c.box))};` : ""}min-height:${Math.round(c.box.height)}px;">` + body.html + '</div>' };
  }
  const root = group(layout.components.filter((c) => c.parent === null), assigned.get("\0") ?? []);
  lines?.push(...root.lines);
  return `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;overflow:hidden;"><div style="width:100%;">` + root.html + '</div>' + (caption ? `<p>${escapeHtml(caption)}</p>` : "") + '</div>';
}

const bounds = (ws: readonly OcrWord[]): Box => {
  const x = Math.min(...ws.map((w) => w.x)), y = Math.min(...ws.map((w) => w.y));
  return { x, y, width: Math.max(...ws.map((w) => w.x + w.width)) - x, height: Math.max(...ws.map((w) => w.y + w.height)) - y };
};

/** Words in text rows (vertically overlapping words), and consecutive rows
 *  merged into one block unless a child component lies between them. */
function textBlocks(words: readonly OcrWord[], children: readonly LayoutComponent[]): OcrWord[][] {
  const rows: OcrWord[][] = [];
  for (const w of [...words].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2))) {
    const row = rows.at(-1);
    const middle = row && bounds(row).y + bounds(row).height / 2;
    if (row && Math.abs(w.y + w.height / 2 - middle!) < w.height / 2) row.push(w);
    else rows.push([w]);
  }
  const blocks: OcrWord[][] = [];
  for (const row of rows) {
    const block = blocks.at(-1);
    const top = block && bounds(block).y + bounds(block).height, bottom = bounds(row).y;
    if (block && !children.some((c) => c.box.y + c.box.height / 2 > top! && c.box.y + c.box.height / 2 < bottom)) block.push(...row);
    else blocks.push([...row]);
  }
  return blocks;
}

/** Share of a line's pixels that must change for it to count as an edge. */
const EDGE = 0.75;
/** Closest two boundaries in a stack may come (px). */
const MIN_STRIP = 6;
/** Cost of leaving a boundary where the pixels show no edge. */
const NO_EDGE = 0.5;

type Axis = "x" | "y";
const span = (b: Box, axis: Axis) => (axis === "x" ? [b.x, b.x + b.width] : [b.y, b.y + b.height]) as [number, number];
const across = (axis: Axis): Axis => (axis === "x" ? "y" : "x");

/** Siblings laid out one after another along `axis`, sharing most of the other axis. */
function stackAxis(nodes: readonly LayoutComponent[]): Axis | null {
  if (nodes.length < 2) return null;
  for (const axis of ["y", "x"] as const) {
    const sorted = [...nodes].sort((a, b) => span(a.box, axis)[0] - span(b.box, axis)[0]);
    const stacked = sorted.every((c, i) => {
      if (i === 0) return true;
      const p = sorted[i - 1]!, [a0, a1] = span(p.box, across(axis)), [b0, b1] = span(c.box, across(axis));
      return span(c.box, axis)[0] >= span(p.box, axis)[1] - 3 && Math.min(a1, b1) - Math.max(a0, b0) >= 0.5 * Math.min(a1 - a0, b1 - b0);
    });
    if (stacked) return axis;
  }
  return null;
}

/** For each line across `axis` from `from` to `to`: the share of its pixels
 *  within [lo, hi) that differ from the line before. */
function edgeProfile(pixels: Pixels, axis: Axis, from: number, to: number, lo: number, hi: number): Map<number, number> {
  const profile = new Map<number, number>();
  const at = (u: number, v: number) => (axis === "y" ? v * pixels.width + u : u * pixels.width + v) * 4;
  const back = axis === "y" ? pixels.width * 4 : 4;
  for (let v = Math.max(1, from); v < to; v++) {
    let hits = 0;
    for (let u = lo; u < hi; u++) {
      const o = at(u, v);
      if (Math.abs(pixels.data[o]! - pixels.data[o - back]!) + Math.abs(pixels.data[o + 1]! - pixels.data[o + 1 - back]!) + Math.abs(pixels.data[o + 2]! - pixels.data[o + 2 - back]!) > 12) hits++;
    }
    profile.set(v, hits / Math.max(1, hi - lo));
  }
  return profile;
}

/** Vision models place boxes roughly: thin strips (tab bars, breadcrumbs,
 *  toolbars) often come out squashed or shifted. Move each boundary between
 *  stacked siblings, columns or rows alike, to a nearby strong pixel edge that
 *  doesn't cut through an OCR word, keeping the boundaries in order. Contents
 *  of a moved component are stretched with it. Geometry stays as the model
 *  gave it where no such edge exists. Never infers text. */
export function refineLayout(layout: VisionLayout, pixels: Pixels, words: readonly OcrWord[] = []): VisionLayout {
  let components = structuredClone(layout.components);
  const image: Box = { x: 0, y: 0, width: pixels.width, height: pixels.height };
  const parents: (string | null)[] = [null];
  for (let p = 0; p < parents.length; p++) {
    const parentId = parents[p]!;
    const nodes = components.filter((c) => c.parent === parentId);
    parents.push(...nodes.map((c) => c.id));
    const axis = stackAxis(nodes);
    if (!axis) continue;
    const sorted = [...nodes].sort((a, b) => span(a.box, axis)[0] - span(b.box, axis)[0]);
    const [start, end] = span(components.find((c) => c.id === parentId)?.box ?? image, axis);
    const lo = Math.round(Math.min(...sorted.map((c) => span(c.box, across(axis))[0])));
    const hi = Math.round(Math.max(...sorted.map((c) => span(c.box, across(axis))[1])));
    const radius = Math.max(8, (end - start) * 0.1);
    const profile = edgeProfile(pixels, axis, Math.ceil(start), Math.floor(end), lo, hi);
    const inside = words.filter((w) => { const m = span(w, across(axis)); return (m[0] + m[1]) / 2 >= lo && (m[0] + m[1]) / 2 < hi; });
    const cutsText = (v: number) => inside.some((w) => { const [a, b] = span(w, axis); return v > a + 2 && v < b - 2; });

    // Each boundary keeps its place or moves to an edge: moving costs more with
    // distance and less with edge strength; keeping it where the pixels show
    // no edge costs NO_EDGE. Pick the cheapest set that stays in order.
    const boundaries = sorted.slice(1).map((c, i) => (span(sorted[i]!.box, axis)[1] + span(c.box, axis)[0]) / 2);
    const options = boundaries.map((b) => [{ at: b, cost: (profile.get(Math.round(b)) ?? 0) >= EDGE ? 0 : NO_EDGE }, ...[...profile]
      .filter(([v, share]) => share >= EDGE && Math.abs(v - b) <= radius && !cutsText(v))
      .map(([v, share]) => ({ at: v, cost: Math.abs(v - b) / radius - share }))]);
    let best: { cost: number; path: number[] }[] = options[0]!.map((o) => ({ cost: o.at >= start + MIN_STRIP ? o.cost : Infinity, path: [o.at] }));
    for (const row of options.slice(1)) {
      best = row.map((o) => best.reduce((top, prev) => {
        const cost = o.at >= prev.path.at(-1)! + MIN_STRIP ? prev.cost + o.cost : Infinity;
        return cost < top.cost ? { cost, path: [...prev.path, o.at] } : top;
      }, { cost: Infinity, path: [] as number[] }));
    }
    const chosen = best.filter((b) => b.path.at(-1)! <= end - MIN_STRIP).sort((a, b) => a.cost - b.cost)[0];
    if (!chosen || !Number.isFinite(chosen.cost) || chosen.path.every((v, i) => v === boundaries[i])) continue;

    // Piecewise-linear map along the axis: old boundaries onto the new ones.
    const from = [start, ...boundaries, end], to = [start, ...chosen.path, end];
    const map = (v: number) => {
      const next = from.findIndex((f, k) => k > 0 && v <= f);
      const i = next < 0 ? from.length - 2 : next - 1;
      const [f0, f1, t0, t1] = [from[i]!, from[i + 1]!, to[i]!, to[i + 1]!];
      return f1 === f0 ? t0 : t0 + (v - f0) * (t1 - t0) / (f1 - f0);
    };
    const moved = new Set(sorted.map((c) => c.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of components) if (c.parent !== null && moved.has(c.parent) && !moved.has(c.id)) { moved.add(c.id); grew = true; }
    }
    components = components.map((c) => {
      if (!moved.has(c.id)) return c;
      const [a, b] = span(c.box, axis);
      const [na, nb] = [map(a), map(b)];
      return { ...c, box: axis === "x" ? { ...c.box, x: na, width: nb - na } : { ...c.box, y: na, height: nb - na } };
    });
  }
  return validateLayout({ ...layout, components }, pixels.width, pixels.height) ?? layout;
}
