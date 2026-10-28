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

/** Table columns survive conservative Canvas CSS allowlists. Narrow views scroll locally. */
export function renderLayout(layout: VisionLayout, words: readonly OcrWord[], width: number, label: string, caption: string | null, paint: (words: OcrWord[], box: Box) => string): string {
  const assigned = assignLayoutWords(layout, words);
  function group(nodes: LayoutComponent[]): string {
    if (!nodes.length) return "";
    const sorted = [...nodes].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    // Partition into horizontal bands. Overlapping vertical ranges share a row.
    const bands: LayoutComponent[][] = [];
    for (const c of sorted) {
      const band = bands[bands.length - 1];
      if (band && c.box.y < Math.max(...band.map((n) => n.box.y + n.box.height)) - 3) band.push(c);
      else bands.push([c]);
    }
    return bands.map((band) => {
      band.sort((a, b) => a.box.x - b.box.x);
      if (band.length === 1) return node(band[0]!);
      const total = band.reduce((s, c) => s + c.box.width, 0);
      return '<table role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse;border:none;"><tbody><tr>' + band.map((c) => `<td style="width:${100 * c.box.width / total}%;vertical-align:top;padding:0;border:none;">${node(c)}</td>`).join("") + '</tr></tbody></table>';
    }).join("");
  }
  function node(c: LayoutComponent): string {
    const own = assigned.get(c.id) ?? [];
    return `<div id="layout-${c.id}" style="min-width:0;overflow:hidden;min-height:${Math.round(c.box.height)}px;">` + (own.length ? paint(own, c.box) : "") + group(layout.components.filter((n) => n.parent === c.id)) + '</div>';
  }
  const leftover = assigned.get("\0") ?? [];
  return `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;overflow-x:auto;"><div style="width:100%;min-width:${Math.min(width, 640)}px;">` + group(layout.components.filter((c) => c.parent === null)) + (leftover.length ? paint(leftover, { x: 0, y: 0, width, height: 0 }) : "") + '</div>' + (caption ? `<p>${escapeHtml(caption)}</p>` : "") + '</div>';
}

/** Snap approximate column boundaries to a strong full-height pixel edge.
 * Never infer text, and leave geometry alone when no reliable separator exists. */
export function refineLayout(layout: VisionLayout, pixels: Pixels): VisionLayout {
  let result = structuredClone(layout);
  const roots = layout.components.filter((c) => c.parent === null).sort((a, b) => a.box.x - b.box.x);
  for (let i = 1; i < roots.length; i++) {
    const left = result.components.find((c) => c.id === roots[i - 1]!.id)!;
    const right = result.components.find((c) => c.id === roots[i]!.id)!;
    const boundary = right.box.x;
    if (Math.abs(left.box.x + left.box.width - boundary) > 3 || Math.abs(left.box.y - right.box.y) > 3) continue;
    const y0 = Math.ceil(Math.max(left.box.y, right.box.y));
    const y1 = Math.floor(Math.min(left.box.y + left.box.height, right.box.y + right.box.height));
    if (y1 - y0 < pixels.height * 0.7) continue;
    let best = boundary, bestScore = 0.8;
    const radius = Math.round(pixels.width * 0.08);
    for (let x = Math.max(1, Math.round(boundary) - radius); x < Math.min(pixels.width, boundary + radius); x++) {
      let hits = 0;
      for (let y = y0; y < y1; y++) {
        const offset = (y * pixels.width + x) * 4;
        const delta = Math.abs(pixels.data[offset]! - pixels.data[offset - 4]!) + Math.abs(pixels.data[offset + 1]! - pixels.data[offset - 3]!) + Math.abs(pixels.data[offset + 2]! - pixels.data[offset - 2]!);
        if (delta > 12) hits++;
      }
      const score = hits / (y1 - y0) - Math.abs(x - boundary) / pixels.width * 0.02;
      if (score > bestScore) { best = x; bestScore = score; }
    }
    if (best === boundary) continue;
    const mapX = (x: number) => x <= boundary ? x * best / boundary : best + (x - boundary) * (pixels.width - best) / (pixels.width - boundary);
    result = { ...result, components: result.components.map((c) => ({ ...c, box: { ...c.box, x: mapX(c.box.x), width: mapX(c.box.x + c.box.width) - mapX(c.box.x) } })) };
  }
  return validateLayout(result, pixels.width, pixels.height) ?? layout;
}
