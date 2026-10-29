import { describe, expect, it } from "vitest";
import { checkCanvasSafe } from "../src/core/canvas";
import { cleanCode, highlightCode, repairJsonBraces } from "../src/core/code";
import { codeRows, parseCrumbs, parseSidebar, parseTabs, renderEditorWindow } from "../src/core/editor-window";
import { CODE_THEME } from "../src/core/theme";

// As OCR read the panels of a real VS Code screenshot.
const sidebar = ["Explorer                         aoe", "v ImgHtml              @efca", "  > .venv", "  > docs", "Y web", "  > .claude", "  > dist"];
const editor = [
  "  Preview README.md     {} packagejson X     ImgtoHTML     ® imgtoHTML",
  "web > {} package,json >...",
  "  7   t",
  "  2     “name”: “web”,",
  "  3     “private”: true,",
  "        Debug",
  "  4     “scripts”: {",
  "  5       “app”: “bash start.sh”",
  "  6   b",
];

describe("editor window parts", () => {
  it("reads the Explorer tree, with open and closed folders by depth", () => {
    expect(parseSidebar(sidebar)).toEqual({
      title: "Explorer",
      items: [
        { depth: 0, kind: "open", name: "ImgHtml" },
        { depth: 1, kind: "closed", name: ".venv" },
        { depth: 1, kind: "closed", name: "docs" },
        { depth: 0, kind: "open", name: "web" },
        { depth: 1, kind: "closed", name: ".claude" },
        { depth: 1, kind: "closed", name: "dist" },
      ],
    });
  });

  it("reads tabs (the one with a close mark is active) and the breadcrumb", () => {
    expect(parseTabs(editor[0]!)).toEqual([
      { name: "Preview README.md", active: false },
      { name: "packagejson", active: true },
      { name: "ImgtoHTML", active: false },
      { name: "imgtoHTML", active: false },
    ]);
    expect(parseCrumbs(editor[1]!)).toEqual(["web", "package,json", "..."]);
  });
});

describe("renderEditorWindow", () => {
  const cleaned = cleanCode(editor);
  const { lines, repaired } = repairJsonBraces(cleaned.lines);
  const html = renderEditorWindow(
    highlightCode(lines.join("\n"), "json", CODE_THEME),
    { sidebar, header: cleaned.header, hints: cleaned.hints, firstLine: cleaned.firstLine },
    "#d4d4d4",
    "VS Code showing package.json",
    null,
  );

  it("keeps the code, numbers from 1, hint row and repaired braces", () => {
    expect(cleaned).toMatchObject({ firstLine: 1, hints: [{ before: 3, text: "Debug" }] });
    expect(repaired).toBe(2);
    expect(lines).toEqual(["{", '  "name": "web",', '  "private": true,', '  "scripts": {', '    "app": "bash start.sh"', "}"]);
    expect(html).toContain('<div aria-hidden="true" style="flex:0 0 38px;');
    expect(html).toContain("▷ Debug");
    expect(html).toContain('<span style="color:#9cdcfe;">&quot;name&quot;</span>');
    expect(html).toContain('<span style="color:#ffd700;">{</span>');
  });

  it("draws sidebar, tabs and breadcrumb hidden from screen readers", () => {
    expect(html).toContain('role="figure" aria-label="VS Code showing package.json"');
    expect(html).toContain('<div aria-hidden="true" style="flex:0 1 150px;min-width:135px;');
    expect(html).toContain('flex:1 1 520px;min-width:280px;');
    expect(html).toContain("<em>packagejson</em>&nbsp;&nbsp;×");
    expect(html).toContain("Preview README.md");
    expect(html).toContain("⌄</span>ImgHtml");
  });

  it("is Canvas-safe", () => {
    expect(checkCanvasSafe(html)).toEqual([]);
    expect(html).not.toMatch(/<(?:table|tr|td)\b/i);
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
