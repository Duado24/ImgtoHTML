import { contrast, rgbHex, sameColor, WHITE, BLACK } from "./colors";
import { lineText, mainColor, type PaintedLine } from "./paint";
import type { Region } from "./regions";
import type { Kind, RGB } from "./types";

/** Python's html.escape(text, quote=True). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const MONO = "Consolas,'Courier New',monospace";

const WRAP = "white-space:pre-wrap;overflow-wrap:anywhere;padding-left:2ch;text-indent:-2ch;";
const NO_WRAP = "white-space:pre;";

/** One line <div>; runs that differ from the container's text color get a <span>. */
function lineDiv(line: PaintedLine, lineStyle: string, indent: string, inherited: RGB | undefined): string {
  const style = lineStyle + (line.background ? `background-color:${rgbHex(line.background)};` : "");
  if (!lineText(line)) return `${indent}<div style="${style}"><br></div>`;

  const body = line.runs
    .map((run) => {
      const css =
        (run.color && !sameColor(run.color, inherited) ? `color:${rgbHex(run.color)};` : "") +
        (run.background ? `background-color:${rgbHex(run.background)};` : "");
      return css ? `<span style="${css}">${escapeHtml(run.text)}</span>` : escapeHtml(run.text);
    })
    .join("");
  return `${indent}<div style="${style}">${body}</div>`;
}

function captionHtml(caption?: string | null): string {
  return caption
    ? '\n  <p style="margin:10px 0 0;padding:0;' +
        "color:#202124;background-color:transparent;" +
        'font:14px/1.5 Arial,sans-serif;">' +
        escapeHtml(caption) +
        "</p>"
    : "";
}

function figure(label: string, inner: string, caption?: string | null): string {
  return (
    `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;min-width:0;margin:0;">\n` +
    inner +
    `${captionHtml(caption)}\n` +
    "</div>"
  );
}

/** A readable fallback text color for a background. */
const readableOn = (bg: RGB): RGB => (contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK);

/** Build the Canvas HTML fragment: one box with the screenshot's
 *  background, one <div> per line.
 *
 *  Each line of text is its own <div>, with no raw line breaks between
 *  them. Canvas's editor once split a <pre> block at a blank line and
 *  moved the rest outside the figure; separate line elements give it
 *  nothing to split.
 *
 *  Long lines:
 *    - code: never wrap (wrapping can change meaning); the code box
 *      scrolls sideways inside itself, the page does not.
 *    - everything else: wrap, with continued parts indented (hanging
 *      indent) so they read as the same line.
 */
export function render(
  lines: readonly PaintedLine[],
  kind: Kind,
  label: string,
  background: RGB,
  foreground: RGB,
  caption?: string | null,
): string {
  const bg = rgbHex(background);
  const fg = rgbHex(foreground);
  const [lineStyle, boxOverflow] = kind === "code" ? [NO_WRAP, "overflow-x:auto;"] : [WRAP, ""];

  const lineDivs = lines.map((line) => lineDiv(line, lineStyle, "    ", foreground)).join("\n");

  return figure(
    label,
    '  <div style="max-width:100%;min-width:0;box-sizing:border-box;' +
      `${boxOverflow}padding:12px;background-color:${bg};color:${fg};` +
      `border:1px solid ${fg};border-radius:6px;` +
      `font:14px/1.5 ${MONO};">\n` +
      `${lineDivs}\n` +
      "  </div>",
    caption,
  );
}

// ------------------------------------------------------------
// Interface screenshots: nested panels
// ------------------------------------------------------------

export interface PaintedLeaf {
  lines: PaintedLine[];
  /** Estimated text size in CSS pixels. */
  fontSize: number;
  /** Space between the panel edge and its text, in pixels. */
  padding: { top: number; right: number; bottom: number; left: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Build the Canvas HTML for a panel tree. Side-by-side panels wrap
 *  under each other on narrow screens (flex-wrap), so nothing scrolls
 *  the page sideways. `paint` gives each leaf panel its lines. */
export function renderPanels(
  tree: Region,
  paint: (leaf: Region & { kind: "leaf" }) => PaintedLeaf,
  label: string,
  caption?: string | null,
): string {
  const border = tree.kind === "split" ? tree.separator : readableOn(tree.background);

  function node(region: Region, extra: string, indent: string): string {
    const bg = rgbHex(region.background);

    if (region.kind === "leaf") {
      const leaf = paint(region);
      const fg = mainColor(leaf.lines) ?? readableOn(region.background);
      const { top, right, bottom, left } = leaf.padding;
      const style =
        `min-width:0;${extra}box-sizing:border-box;background-color:${bg};color:${rgbHex(fg)};` +
        `padding:${top}px ${right}px ${bottom}px ${left}px;font-size:${leaf.fontSize}px;`;
      if (leaf.lines.length === 0) {
        return `${indent}<div style="${style}min-height:${clamp(region.box.height, 0, 80)}px;"></div>`;
      }
      const lines = leaf.lines.map((l) => lineDiv(l, WRAP, indent + "  ", fg)).join("\n");
      return `${indent}<div style="${style}">\n${lines}\n${indent}</div>`;
    }

    const sep = rgbHex(region.separator);
    const last = region.children.length - 1;

    if (region.direction === "row") {
      // The widest panel takes leftover space; the others keep their width.
      const widest = region.children.reduce((a, c, i) => (c.box.width > region.children[a]!.box.width ? i : a), 0);
      const kids = region.children
        .map((child, i) => {
          const w = child.box.width;
          const flex = `flex:${i === widest ? 1 : 0} 1 ${w}px;min-width:${clamp(w * 0.6, 0, 200)}px;`;
          const line = i < last ? `border-right:1px solid ${sep};` : "";
          return node(child, flex + line, indent + "  ");
        })
        .join("\n");
      return `${indent}<div style="min-width:0;${extra}display:flex;flex-wrap:wrap;background-color:${bg};">\n${kids}\n${indent}</div>`;
    }

    const kids = region.children
      .map((child, i) => node(child, i < last ? `border-bottom:1px solid ${sep};` : "", indent + "  "))
      .join("\n");
    return `${indent}<div style="min-width:0;${extra}background-color:${bg};">\n${kids}\n${indent}</div>`;
  }

  const root = node(
    tree,
    `max-width:100%;box-sizing:border-box;overflow:hidden;border:1px solid ${rgbHex(border)};` +
      `border-radius:6px;font-family:${MONO};line-height:1.5;`,
    "  ",
  );
  return figure(label, root, caption);
}

/** Compact component content; structural positioning belongs to its parent. */
export function renderLayoutPanel(panel: PaintedLeaf, background: RGB, foreground: RGB, height = 0): string {
  return `<div style="box-sizing:border-box;min-width:0;min-height:${Math.round(height)}px;overflow:hidden;background-color:${rgbHex(background)};color:${rgbHex(foreground)};font:13px/1.45 Consolas,'Courier New',monospace;padding:0 4px;">` +
    panel.lines.map((line) => lineDiv(line, "white-space:pre;", "", foreground)).join("") + "</div>";
}
