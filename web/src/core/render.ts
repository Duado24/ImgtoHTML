import { rgbHex } from "./colors";
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

/** Build the Canvas HTML fragment.
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
  lines: readonly string[],
  kind: Kind,
  label: string,
  background: RGB,
  foreground: RGB,
  caption?: string | null,
): string {
  const bg = rgbHex(background);
  const fg = rgbHex(foreground);

  const [lineStyle, boxOverflow] =
    kind === "code"
      ? ["white-space:pre;", "overflow-x:auto;"]
      : ["white-space:pre-wrap;overflow-wrap:anywhere;padding-left:2ch;text-indent:-2ch;", ""];

  const lineDivs = lines
    .map((line) => `    <div style="${lineStyle}">` + (line ? escapeHtml(line) : "<br>") + "</div>")
    .join("\n");

  const captionHtml = caption
    ? '\n  <p style="margin:10px 0 0;padding:0;' +
      "color:#202124;background-color:transparent;" +
      'font:14px/1.5 Arial,sans-serif;">' +
      escapeHtml(caption) +
      "</p>"
    : "";

  return (
    `<div role="figure" aria-label="${escapeHtml(label)}" style="max-width:100%;min-width:0;margin:0;">\n` +
    '  <div style="max-width:100%;min-width:0;box-sizing:border-box;' +
    `${boxOverflow}padding:12px;background-color:${bg};color:${fg};` +
    `border:1px solid ${fg};border-radius:6px;` +
    "font:14px/1.5 Consolas,'Courier New',monospace;\">\n" +
    `${lineDivs}\n` +
    "  </div>" +
    `${captionHtml}\n` +
    "</div>"
  );
}
