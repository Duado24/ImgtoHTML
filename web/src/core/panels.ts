/** App and website screenshots: the report's regions drawn as nested panels,
 *  in the colors the report gives (contrast fixed). Regions side by side in
 *  the screenshot sit in a flex row that wraps on narrow screens; a sidebar
 *  stays narrow and the main panel takes the room. No tables. */

import { highlightCode, detectLanguage } from "./code";
import { fixContrast, hexRgb, readableOn, rgbHex } from "./colors";
import { lineText, plainLines, type PaintedLine } from "./paint";
import type { Application, ReportRegion } from "./report";
import { escapeHtml, figure, lineDiv, MONO, SANS, WRAP } from "./render";
import { CODE_THEME, TERMINAL_THEME } from "./theme";
import type { Box, RGB } from "./types";

/** A text color the report gave, the color the page uses instead, and the background it's on. */
export interface ColorChange {
  region: string;
  from: string;
  to: string;
  background: string;
}

/** Background and text colors when the report gives none. */
const DEFAULTS: Record<Application, { background: string; color: string }> = {
  website: { background: "#ffffff", color: "#1f2328" },
  desktop: { background: "#f5f5f5", color: "#1d1d1f" },
  ide: { background: "#1f1f1f", color: "#cccccc" },
  "code-editor": { background: "#1f1f1f", color: "#cccccc" },
  terminal: { background: "#1e1e1e", color: "#cccccc" },
  other: { background: "#ffffff", color: "#1f2328" },
};

/** Share of the shorter of two boxes' heights they must share to sit in one row. */
const SAME_ROW = 0.5;
/** Grid units → CSS pixels for a panel's preferred width (a Canvas page is about 720 px wide). */
const PX_PER_UNIT = 0.72;

const WHOLE: Box = { x: 0, y: 0, width: 1000, height: 1000 };

/** A color `share` of the way from background to text. */
const mix = (background: RGB, text: RGB, share: number): RGB => background.map((v, i) => Math.round(v + (text[i]! - v) * share)) as unknown as RGB;
/** Borders that show on either background or text. */
const borderOf = (background: RGB, text: RGB): RGB => mix(background, text, 0.22);

/** Siblings in reading order, grouped into rows of boxes side by side. */
function rows(regions: readonly ReportRegion[]): ReportRegion[][] {
  const out: ReportRegion[][] = [];
  for (const region of regions) {
    const box = region.box ?? WHOLE;
    const row = out.at(-1);
    const fits = row?.every((other) => {
      const b = other.box ?? WHOLE;
      const shared = Math.min(box.y + box.height, b.y + b.height) - Math.max(box.y, b.y);
      const apart = box.x >= b.x + b.width - 5 || b.x >= box.x + box.width - 5;
      return apart && shared >= SAME_ROW * Math.min(box.height, b.height);
    });
    if (row && fits) row.push(region);
    else out.push([region]);
  }
  return out;
}

/** "…" at the end of each line the screenshot cuts off. */
export function withCutOff(lines: readonly string[], cut: readonly number[] = []): string[] {
  return lines.map((l, i) => (cut.includes(i + 1) && !/(?:…|\.{3})\s*$/.test(l) ? `${l}…` : l));
}

/** Draw the report's regions as nested, wrapping panels. */
export function renderPanels(
  regions: readonly ReportRegion[],
  application: Application,
  label: string,
  caption?: string | null,
): { html: string; changes: ColorChange[] } {
  const changes: ColorChange[] = [];
  const defaults = DEFAULTS[application];
  const pageBackground = hexRgb(regions.find((r) => r.parent === null && r.background)?.background ?? defaults.background);

  function colorsOf(region: ReportRegion, inherited: { background: RGB; color: RGB }, mono: boolean) {
    const theme = region.type === "terminal" ? TERMINAL_THEME : CODE_THEME;
    const background = region.background ? hexRgb(region.background) : mono && !region.color ? theme.background : inherited.background;
    const wanted = region.color ? hexRgb(region.color) : mono && !region.background ? theme.colors.text
      : region.background ? readableOn(background) : inherited.color;
    const color = fixContrast(wanted, background);
    if (region.color && rgbHex(color) !== rgbHex(wanted)) changes.push({ region: region.id, from: rgbHex(wanted), to: rgbHex(color), background: rgbHex(background) });
    return { background, color };
  }

  function paint(region: ReportRegion, background: RGB): PaintedLine[] {
    const lines = withCutOff(region.lines, region.cut_off_lines);
    if (region.type !== "code") return plainLines(lines);
    const code = lines.join("\n");
    const painted = highlightCode(code, detectLanguage(code), CODE_THEME);
    // Syntax colors are made for a dark editor; keep them readable on this background.
    return painted.map((line) => ({ ...line, runs: line.runs.map((run) => (run.color ? { ...run, color: fixContrast(run.color, background) } : run)) }));
  }

  /** The region's lines, each highlight drawn edge to edge, and a line-number
   *  gutter when the report gives first_line (code panels inside apps, logs). */
  function linesHtml(region: ReportRegion, background: RGB, color: RGB, indent: string): string {
    const painted = paint(region, background);
    const marks = new Map<number, { background?: RGB; color: RGB }>();
    for (const h of region.highlights ?? []) {
      const bg = h.background ? hexRgb(h.background) : undefined;
      const fg = fixContrast(h.color ? hexRgb(h.color) : color, bg ?? background);
      for (const n of h.lines) marks.set(n - 1, { ...(bg ? { background: bg } : {}), color: fg });
    }
    const first = region.first_line;
    const digits = first ? String(first + painted.length - 1).length : 0;
    const muted = mix(background, color, 0.6);
    return painted.map((line, i) => {
      const mark = marks.get(i);
      const text = mark ? { runs: line.runs.map((r) => ({ ...r, color: fixContrast(r.color ?? mark.color, mark.background ?? background) })) } : line;
      const inherited = lineText(line) ? color : undefined;
      const row = mark?.background ? `margin:0 -14px;padding:0 14px;background-color:${rgbHex(mark.background)};` : "";
      if (!first) return row ? `${indent}<div style="${row}">${lineDiv(text, WRAP, "", inherited)}</div>` : lineDiv(text, WRAP, indent, inherited);
      const number = `<div aria-hidden="true" style="flex:0 0 ${digits + 2}ch;box-sizing:border-box;text-align:right;padding-right:2ch;` +
        `color:${rgbHex(fixContrast(muted, mark?.background ?? background))};">${first + i}</div>`;
      return `${indent}<div style="display:flex;min-width:0;${row}">${number}${lineDiv(text, `flex:1;min-width:0;${WRAP}`, "", inherited)}</div>`;
    }).join("\n");
  }

  function itemsHtml(region: ReportRegion, indent: string): string {
    // Tabs and toolbars: the items of each line become chips that wrap.
    return region.lines.map((line) => {
      const items = line.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean);
      const chips = items.map((t) => `<span style="display:inline-block;margin:0 14px 4px 0;">${escapeHtml(t)}</span>`).join("");
      return `${indent}<div style="white-space:normal;">${chips || "<br>"}</div>`;
    }).join("\n");
  }

  function node(region: ReportRegion, inherited: { background: RGB; color: RGB }, extra: string, indent: string): string {
    const mono = region.type === "code" || region.type === "terminal";
    const { background, color } = colorsOf(region, inherited, mono);
    const own = region.lines.some((l) => l.trim());
    const children = regions.filter((r) => r.parent === region.id);
    const font = mono ? `font:14px/1.5 ${MONO};` : `font:15px/1.5 ${SANS};`;
    const body = !own ? ""
      : region.type === "tabs" || region.type === "toolbar" || region.type === "breadcrumbs" ? itemsHtml(region, indent + "  ")
      : linesHtml(region, background, color, indent + "  ");
    const inner = [body, group(children, { background, color }, indent + "  ")].filter(Boolean).join("\n");
    if (!inner) return "";
    const weight = region.type === "tabs" || region.type === "toolbar" ? "font-weight:600;" : "";
    return `${indent}<div style="min-width:0;max-width:100%;box-sizing:border-box;${extra}padding:10px 14px;` +
      `background-color:${rgbHex(background)};color:${rgbHex(color)};${font}${weight}">\n${inner}\n${indent}</div>`;
  }

  function group(siblings: readonly ReportRegion[], inherited: { background: RGB; color: RGB }, indent: string): string {
    const border = rgbHex(borderOf(inherited.background, inherited.color));
    return rows(siblings).map((row, r, all) => {
      const below = r < all.length - 1 ? `border-bottom:1px solid ${border};` : "";
      if (row.length === 1) return node(row[0]!, inherited, below, indent);
      const cells = row.map((region, i) => {
        const w = (region.box ?? WHOLE).width;
        const flex = region.type === "sidebar" ? "flex:0 1 150px;min-width:135px;"
          : `flex:1 1 ${Math.round(w * PX_PER_UNIT)}px;`;
        const right = i < row.length - 1 ? `border-right:1px solid ${border};` : "";
        return node(region, inherited, flex + right, indent + "  ");
      }).filter(Boolean);
      return `${indent}<div style="display:flex;flex-wrap:wrap;min-width:0;${below}">\n${cells.join("\n")}\n${indent}</div>`;
    }).filter(Boolean).join("\n");
  }

  const page = { background: pageBackground, color: fixContrast(hexRgb(defaults.color), pageBackground) };
  const border = rgbHex(borderOf(page.background, page.color));
  const inner = group(regions.filter((r) => r.parent === null), page, "    ");
  const html = figure(
    label,
    `  <div style="max-width:100%;min-width:0;box-sizing:border-box;border:1px solid ${border};border-radius:0.75rem;overflow:hidden;` +
      `background-color:${rgbHex(page.background)};color:${rgbHex(page.color)};">\n${inner}\n  </div>`,
    caption,
  );
  return { html, changes };
}
