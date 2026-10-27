/** Canvas-safe check: would Canvas's HTML editor keep this fragment as is?
 *
 *  Canvas sanitizes pasted HTML against allowlists of elements, attributes
 *  and CSS properties. The lists below are an approximation of those, plus
 *  this project's own rules (no <pre>: Canvas once split one at a blank
 *  line). Paste a sample into your Canvas instance and adjust the lists
 *  when it disagrees. */

export interface CanvasIssue {
  /** "error": Canvas strips or breaks it. "warning": may be stripped or have no effect. */
  level: "error" | "warning";
  message: string;
}

/** Removed by Canvas, or against this project's rules. */
const FORBIDDEN_ELEMENTS = new Set([
  "script", "style", "link", "meta", "base", "form", "input", "button", "select",
  "textarea", "object", "embed", "applet", "frame", "frameset", "pre",
]);

const ALLOWED_ELEMENTS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure",
  "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "ol", "p", "q",
  "s", "samp", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "u", "ul", "var",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "style", "id", "title", "lang", "dir", "role", "alt", "src", "href", "target", "rel",
  "width", "height", "colspan", "rowspan", "scope", "headers",
]);

const ALLOWED_CSS = new Set([
  "background", "background-color", "border", "border-top", "border-right", "border-bottom",
  "border-left", "border-color", "border-style", "border-width", "border-radius",
  "border-collapse", "box-sizing", "color", "display", "flex", "flex-wrap", "flex-direction",
  "flex-grow", "flex-shrink", "flex-basis", "float", "font", "font-family", "font-size", "font-style",
  "font-weight", "height", "letter-spacing", "line-height", "list-style", "list-style-type",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "max-height",
  "max-width", "min-height", "min-width", "overflow", "overflow-x", "overflow-y",
  "overflow-wrap", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "table-layout", "text-align", "text-decoration", "text-indent", "vertical-align", "white-space", "width",
  "word-break",
]);

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const unescape = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function checkStyle(tag: string, css: string, add: (issue: CanvasIssue) => void) {
  for (const declaration of css.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().toLowerCase();
    if (/url\s*\(|expression\s*\(|javascript:/.test(value)) {
      add({ level: "error", message: `<${tag}> style "${property}" uses url(), expression() or javascript:` });
    } else if (property === "position" && /fixed|absolute/.test(value)) {
      add({ level: "error", message: `<${tag}> uses position:${value}, which Canvas removes` });
    } else if (!ALLOWED_CSS.has(property)) {
      add({ level: "warning", message: `<${tag}> style "${property}" may be stripped by Canvas` });
    }
  }
}

/** Every reason the fragment might not survive Canvas, each listed once. */
export function checkCanvasSafe(html: string): CanvasIssue[] {
  const seen = new Set<string>();
  const issues: CanvasIssue[] = [];
  const add = (issue: CanvasIssue) => {
    if (!seen.has(issue.message)) {
      seen.add(issue.message);
      issues.push(issue);
    }
  };

  for (const [, closing, rawName = "", attributes = ""] of html.matchAll(TAG)) {
    if (!rawName || closing) continue;
    const tag = rawName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) add({ level: "error", message: `<${tag}> is not allowed` });
    else if (tag === "h1") add({ level: "warning", message: "<h1> is reserved for the Canvas page title" });
    else if (!ALLOWED_ELEMENTS.has(tag)) add({ level: "warning", message: `<${tag}> may be stripped by Canvas` });

    const names = new Set<string>();
    for (const [, rawAttr = "", dq, sq, bare] of attributes.matchAll(ATTRIBUTE)) {
      const attr = rawAttr.toLowerCase();
      const value = unescape(dq ?? sq ?? bare ?? "");
      names.add(attr);
      if (attr.startsWith("on")) add({ level: "error", message: `<${tag}> has an event handler (${attr})` });
      else if ((attr === "href" || attr === "src") && /^\s*(javascript|vbscript|data):/i.test(value)) {
        add({ level: "error", message: `<${tag}> ${attr} uses a script or data URL` });
      } else if (attr === "class") add({ level: "warning", message: "class has no effect without a stylesheet; use inline styles" });
      else if (attr === "style") checkStyle(tag, value, add);
      else if (!ALLOWED_ATTRIBUTES.has(attr) && !attr.startsWith("aria-")) {
        add({ level: "warning", message: `<${tag}> attribute "${attr}" may be stripped by Canvas` });
      }
    }
    if (tag === "img" && !names.has("alt")) add({ level: "error", message: "<img> without alt text" });
    if (/\brole\s*=\s*["']?figure/i.test(attributes) && !names.has("aria-label") && !names.has("aria-labelledby")) {
      add({ level: "error", message: 'role="figure" without an accessible name (aria-label)' });
    }
  }
  return issues;
}
