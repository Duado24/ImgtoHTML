import { describe, expect, it } from "vitest";
import { checkCanvasSafe } from "../src/core/canvas";
import { highlightCode } from "../src/core/code";
import { codeRows, parseCrumbs, parseSidebar, parseTabs, renderEditorWindow } from "../src/core/editor-window";
import { CODE_THEME } from "../src/core/theme";

// As an AI report gives a VS Code window's explorer (see prompt.ts).
const sidebar = ["EXPLORER", "⌄ ImgHtml", "  › .venv", "  › docs", "⌄ web", "  › .claude", "  › dist", "  package.json"];
const code = ["{", '  "name": "web",', '  "private": true,', '  "scripts": {', '    "app": "bash start.sh"', "  }", "}"];

describe("editor window parts", () => {
  it("reads the Explorer tree, with open and closed folders by depth", () => {
    expect(parseSidebar(sidebar)).toEqual({
      title: "EXPLORER",
      items: [
        { depth: 0, kind: "open", name: "ImgHtml" },
        { depth: 1, kind: "closed", name: ".venv" },
        { depth: 1, kind: "closed", name: "docs" },
        { depth: 0, kind: "open", name: "web" },
        { depth: 1, kind: "closed", name: ".claude" },
        { depth: 1, kind: "closed", name: "dist" },
        { depth: 1, kind: "file", name: "package.json" },
      ],
    });
  });

  it("reads tabs (the one with a close mark is active) and the breadcrumb", () => {
    expect(parseTabs("Preview README.md   package.json ×   ImgtoHTML")).toEqual([
      { name: "Preview README.md", active: false },
      { name: "package.json", active: true },
      { name: "ImgtoHTML", active: false },
    ]);
    expect(parseCrumbs("web > package.json > ...")).toEqual(["web", "package.json", "..."]);
  });
});

describe("renderEditorWindow", () => {
  const html = renderEditorWindow(
    highlightCode(code.join("\n"), "json", CODE_THEME),
    { sidebar, header: ["Preview README.md   package.json ×", "web > package.json > ..."], hints: [], firstLine: 12 },
    "#d4d4d4",
    "VS Code showing package.json",
    null,
  );

  it("keeps the code, colored, numbered from the screenshot's first line", () => {
    expect(html).toContain('<div aria-hidden="true" style="flex:0 0 38px;');
    expect(html).toMatch(/>12<\/div><div[^>]*><span style="color:#ffd700;">\{<\/span>/);
    expect(html).toContain(">18</div>");
    expect(html).toContain('<span style="color:#9cdcfe;">&quot;name&quot;</span>');
  });

  it("draws sidebar, tabs and breadcrumb hidden from screen readers, with a narrow explorer", () => {
    expect(html).toContain('role="figure" aria-label="VS Code showing package.json"');
    expect(html).toContain('<div aria-hidden="true" style="flex:0 1 150px;min-width:135px;');
    expect(html).toContain("flex:1 1 520px;min-width:280px;");
    expect(html).toContain("<em>package.json</em>&nbsp;&nbsp;×");
    expect(html).toContain("Preview README.md");
    expect(html).toContain("⌄</span>ImgHtml");
    expect(html).toContain("border-radius:0.75rem;");
  });

  it("is Canvas-safe and wraps code instead of clipping it", () => {
    expect(checkCanvasSafe(html)).toEqual([]);
    expect(html).not.toMatch(/<(?:table|tr|td|pre)\b/i);
    expect(html).toContain("white-space:pre-wrap;overflow-wrap:anywhere;");
  });
});

describe("code line backgrounds", () => {
  it("gives a line its own background, such as the current line", () => {
    const lines = highlightCode('{\n  "a": 1\n}', "json", CODE_THEME);
    const html = codeRows(lines, [], 1, "#d4d4d4", false, 40, 8, ["#242526", undefined, undefined]);
    expect(html.match(/background-color:#242526;/g)).toHaveLength(1);
    expect(html).toMatch(/<div style="display:flex;min-width:0;background-color:#242526;"><div[^>]*>1</);
    expect(checkCanvasSafe(`<div>${html}</div>`)).toEqual([]);
  });
});
