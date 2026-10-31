import { describe, expect, it } from "vitest";
import { convert } from "../src/core/convert";
import { parseReport, type ScreenshotReport } from "../src/core/report";

const read = (value: object): ScreenshotReport => {
  const parsed = parseReport(JSON.stringify({ format: "imgtohtml-report", version: 1, ...value }));
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.report;
};

const vscode = read({
  kind: "code", application: "ide", language: "json",
  regions: [
    { id: "files", type: "sidebar", parent: null, box: { x: 0, y: 0, width: 250, height: 1000 }, lines: ["EXPLORER", "⌄ web", "  package.json"] },
    { id: "tabs", type: "tabs", parent: null, box: { x: 250, y: 0, width: 750, height: 60 }, lines: ["Preview README.md", "package.json"] },
    { id: "crumbs", type: "breadcrumbs", parent: null, box: { x: 250, y: 60, width: 750, height: 50 }, lines: ["web > package.json > ..."] },
    { id: "code", type: "code", parent: null, box: { x: 250, y: 110, width: 750, height: 890 },
      lines: ["{", '  "name": "web",', '  "description": "Local screenshot to Canvas HTML app, with a TypeScript client and Nod', "}"],
      cut_off_lines: [3], unsure_words: ["Nod"] },
  ],
});

const noTables = (html: string) => expect(html).not.toMatch(/<(?:table|thead|tbody|tr|td|th|pre|style|script)\b/i);

describe("convert", () => {
  it("draws a VS Code report as the editor window, code colored and the cut-off line marked", () => {
    const result = convert(vscode);
    expect(result.renderer).toBe("editor-window");
    expect(result.label).toBe("JSON code: EXPLORER");
    expect(result.html).toContain("<em>package.json</em>&nbsp;&nbsp;×"); // the tab the breadcrumb names is open
    expect(result.html).toContain("and Nod…");
    expect(result.html).toContain('<span style="color:#9cdcfe;">&quot;name&quot;</span>');
    expect(result.transcript).toBe('EXPLORER\n⌄ web\n  package.json\nPreview README.md\npackage.json\nweb > package.json > ...\n{\n  "name": "web",\n  "description": "Local screenshot to Canvas HTML app, with a TypeScript client and Nod…\n}');
    expect(result.canvasIssues).toEqual([]);
    noTables(result.html);
  });

  it("lists what to check: unsure words and cut-off lines", () => {
    expect(convert(vscode).checks).toEqual([{
      region: "code", title: "Code",
      lines: ["{", '  "name": "web",', '  "description": "Local screenshot to Canvas HTML app, with a TypeScript client and Nod…', "}"],
      unsure: ["Nod"], cutOff: [3],
    }]);
  });

  it("draws plain code without the window when asked, numbered nowhere", () => {
    const result = convert(vscode, { editorWindow: false, label: "My label", caption: "From lesson 2" });
    expect(result.renderer).toBe("code");
    expect(result.html).toContain('aria-label="My label"');
    expect(result.html).toContain("From lesson 2</p>");
    expect(result.html).not.toContain("EXPLORER");
    expect(result.htmlFile.name).toBe("Media_My_label.html");
  });

  it("draws a terminal with the course theme, prompts green and errors red", () => {
    const result = convert(read({ kind: "terminal", application: "terminal", regions: [
      { id: "t", type: "terminal", parent: null, lines: ["user@host:~$ cat notes.txt", "cat: notes.txt: No such file or directory"] },
    ] }));
    expect(result.renderer).toBe("terminal");
    expect(result.html).toContain('<span style="color:#23d18b;">user@host:~$ </span>');
    expect(result.html).toContain('style="white-space:pre-wrap;overflow-wrap:anywhere;padding-left:2ch;text-indent:-2ch;"><span style="color:#f25858;">cat: notes.txt');
    expect(result.html).toContain("background-color:#1e1e1e;");
    noTables(result.html);
  });

  it("masks user names in home folders, everywhere they appear", () => {
    const result = convert(read({ kind: "terminal", application: "terminal", regions: [
      { id: "t", type: "terminal", parent: null, lines: ["PS C:\\Users\\alice\\CS104> whoami", "alice@ensign.edu"], unsure_words: ["alice"] },
    ] }));
    expect(result.transcript).toBe("PS C:\\Users\\username\\CS104> whoami\nusername@ensign.edu");
    expect(result.html).not.toContain("alice");
    expect(result.maskedNames).toBe(1);
  });

  it("describes a diagram in words, with its parts and connections", () => {
    const result = convert(read({ kind: "diagram", application: "other",
      regions: [{ id: "d", type: "content", parent: null, lines: ["Start", "Check"] }],
      diagram: { summary: "A two-step flow.", nodes: [{ id: "a", label: "Start", shape: "start" }, { id: "b", label: "Check", shape: "decision" }], edges: [{ from: "a", to: "b", label: "" }] } }));
    expect(result.renderer).toBe("diagram");
    expect(result.label).toBe("Diagram: A two-step flow.");
    expect(result.html).toContain("From Start to Check");
    expect(result.transcript.startsWith("A two-step flow.")).toBe(true);
  });

  it("draws an app screenshot as panels, and passes the AI's notes on", () => {
    const result = convert(read({ kind: "interface", application: "desktop", notes: "Password dots left out.",
      regions: [{ id: "dialog", type: "content", parent: null, lines: ["Enter your password to allow this.", "Cancel  OK"] }] }));
    expect(result.renderer).toBe("panels");
    expect(result.notes).toBe("Password dots left out.");
    expect(result.html).toContain("Enter your password to allow this.");
    noTables(result.html);
  });
});
