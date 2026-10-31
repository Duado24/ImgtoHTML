import { describe, expect, it } from "vitest";
import { checkCanvasSafe } from "../src/core/canvas";
import { contrast, hexRgb } from "../src/core/colors";
import { renderPanels, withCutOff } from "../src/core/panels";
import type { ReportRegion } from "../src/core/report";

const region = (r: Partial<ReportRegion> & Pick<ReportRegion, "id" | "type">): ReportRegion => ({ parent: null, lines: [], ...r });

describe("renderPanels", () => {
  // A website: a top bar, then a sidebar beside the main content with a dialog in it.
  const regions = [
    region({ id: "bar", type: "toolbar", box: { x: 0, y: 0, width: 1000, height: 80 }, background: "#24292f", color: "#ffffff", lines: ["Classroom  Settings"] }),
    region({ id: "nav", type: "sidebar", box: { x: 0, y: 80, width: 200, height: 920 }, lines: ["Assignments", "Students"] }),
    region({ id: "main", type: "content", box: { x: 200, y: 80, width: 800, height: 920 }, lines: ["CS220-CC-01"] }),
    region({ id: "dialog", type: "content", parent: "main", box: { x: 300, y: 200, width: 400, height: 300 }, background: "#ffffff", color: "#999999", lines: ["Reuse assignment", "Week 0 Code Challenge"], cut_off_lines: [2] }),
  ];
  const { html, changes } = renderPanels(regions, "website", "GitHub Classroom page");

  it("stacks rows and puts side-by-side regions in a wrapping flex row, sidebar narrow", () => {
    expect(html).toContain('<div style="display:flex;flex-wrap:wrap;min-width:0;');
    expect(html).toContain("flex:0 1 150px;min-width:135px;");
    expect(html).toContain("flex:1 1 576px;");
    expect(html.indexOf("Classroom")).toBeLessThan(html.indexOf("Assignments"));
    expect(html.indexOf("CS220-CC-01")).toBeLessThan(html.indexOf("Reuse assignment"));
  });

  it("shows toolbar items as chips that wrap", () => {
    expect(html).toContain('<span style="display:inline-block;margin:0 14px 4px 0;">Classroom</span><span style="display:inline-block;margin:0 14px 4px 0;">Settings</span>');
  });

  it("uses the report's colors, fixing text that doesn't reach 4.5:1", () => {
    expect(html).toContain("background-color:#24292f;color:#ffffff;");
    expect(changes).toEqual([{ region: "dialog", from: "#999999", to: expect.any(String), background: "#ffffff" }]);
    expect(contrast(hexRgb(changes[0]!.to), hexRgb("#ffffff"))).toBeGreaterThanOrEqual(4.5);
  });

  it("marks cut-off lines and is Canvas-safe, without tables, rounded at 0.75rem", () => {
    expect(html).toContain("Week 0 Code Challenge…");
    expect(html).toContain("border-radius:0.75rem;");
    expect(checkCanvasSafe(html)).toEqual([]);
    expect(html).not.toMatch(/<(?:table|tr|td|pre)\b/i);
  });

  it("draws a code region inside an app in monospace with syntax colors", () => {
    const out = renderPanels([region({ id: "c", type: "code", lines: ["print('hi')"] })], "website", "Code cell").html;
    expect(out).toContain("Consolas");
    expect(out).toMatch(/<span style="color:#[0-9a-f]{6};">print<\/span>/);
  });

  it("draws a log's line numbers and highlighted lines, edge to edge, readable", () => {
    const log = region({
      id: "log", type: "terminal", background: "#0d1117", color: "#e6edf3", first_line: 2710,
      lines: ["Error: R]", "", "✅ Git collaboration"],
      highlights: [{ lines: [1], background: "#3d1d20", color: "#ff0000" }, { lines: [3], color: "#3fb950" }],
    });
    const out = renderPanels([log], "website", "Log").html;
    expect(out).toContain('aria-hidden="true"');
    expect(out).toMatch(/>2710<\/div>[\s\S]*>2711<\/div>[\s\S]*>2712<\/div>/);
    expect(out).not.toContain("2710 ");
    expect(out).toContain("margin:0 -14px;padding:0 14px;background-color:#3d1d20;");
    const red = out.match(/<span style="color:(#[0-9a-f]{6});">Error: R\]<\/span>/)![1]!;
    expect(contrast(hexRgb(red), hexRgb("#3d1d20"))).toBeGreaterThanOrEqual(4.5);
    expect(out).toMatch(/<span style="color:#3fb950;">✅ Git collaboration<\/span>/);
    expect(checkCanvasSafe(out)).toEqual([]);
  });
});

describe("withCutOff", () => {
  it("adds … to cut-off lines once", () => {
    expect(withCutOff(["a", "b", "c…"], [2, 3])).toEqual(["a", "b…", "c…"]);
  });
});
