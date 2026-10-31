import { rgbHex, sameColor } from "./colors";
import { lineText, type PaintedLine } from "./paint";
import type { RGB } from "./types";

/** Python's html.escape(text, quote=True). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export const MONO = "Consolas,'Courier New',monospace";
export const SANS = "'Segoe UI',Arial,Helvetica,sans-serif";
/** Long lines wrap, continued parts indented (hanging indent) so they read as one line. */
export const WRAP = "white-space:pre-wrap;overflow-wrap:anywhere;padding-left:2ch;text-indent:-2ch;";

/** One line <div>; runs that differ from the container's text color get a <span>. */
export function lineDiv(line: PaintedLine, lineStyle: string, indent: string, inherited: RGB | undefined): string {
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

/** The outer element: a labelled figure for screen readers, with an optional visible caption. */
export function figure(label: string, inner: string, caption?: string | null): string {
  return (
    `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;min-width:0;margin:0;">\n` +
    inner +
    `${captionHtml(caption)}\n` +
    "</div>"
  );
}

/** One box with the theme's background, one <div> per line.
 *
 *  Each line of text is its own <div>, with no raw line breaks between
 *  them. Canvas's editor once split a <pre> block at a blank line and
 *  moved the rest outside the figure; separate line elements give it
 *  nothing to split. Long lines wrap with a hanging indent; the copied
 *  text keeps its original lines. */
export function render(
  lines: readonly PaintedLine[],
  label: string,
  background: RGB,
  foreground: RGB,
  caption?: string | null,
): string {
  const bg = rgbHex(background);
  const fg = rgbHex(foreground);
  const lineDivs = lines.map((line) => lineDiv(line, WRAP, "    ", foreground)).join("\n");

  return figure(
    label,
    '  <div style="max-width:100%;min-width:0;box-sizing:border-box;' +
      `padding:12px;background-color:${bg};color:${fg};` +
      `border:1px solid ${fg};border-radius:0.75rem;` +
      `font:14px/1.5 ${MONO};">\n` +
      `${lineDivs}\n` +
      "  </div>",
    caption,
  );
}
