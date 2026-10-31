import { describe, expect, it } from "vitest";
import { hexColor, parseReport, reportText } from "../src/core/report";

const report = (over: Record<string, unknown> = {}) => ({
  format: "imgtohtml-report", version: 1, kind: "code", application: "ide", language: "json",
  regions: [
    { id: "files", type: "sidebar", parent: null, box: { x: 0, y: 0, width: 200, height: 1000 }, background: "#181818", lines: ["EXPLORER", "› docs"] },
    { id: "code", type: "code", parent: null, box: { x: 200, y: 0, width: 800, height: 1000 },
      lines: ["{", '  "name": "imgtohtml-web",', '  "description": "Local app and Nod'], cut_off_lines: [3], unsure_words: ["Nod"] },
  ],
  ...over,
});
const parse = (value: unknown) => parseReport(typeof value === "string" ? value : JSON.stringify(value));

describe("screenshot reports", () => {
  it("accepts a valid report, keeping leading spaces, colors and per-line notes", () => {
    const result = parse(report());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.regions[0]).toMatchObject({ id: "files", type: "sidebar", background: "#181818", box: { x: 0, y: 0, width: 200, height: 1000 } });
    expect(result.report.regions[1]!.lines[1]).toBe('  "name": "imgtohtml-web",');
    expect(result.report.regions[1]!.cut_off_lines).toEqual([3]);
    expect(result.warnings).toEqual([]);
  });

  it("accepts the JSON inside a ```json fence, as chat assistants hand it over", () => {
    expect(parse("Here is the report:\n```json\n" + JSON.stringify(report()) + "\n```\n").ok).toBe(true);
  });

  it("lists every problem at once, so they can all go back to the AI in one message", () => {
    const result = parse(report({
      version: 2, kind: "photo",
      regions: [
        { id: "a b", type: "window", parent: "nowhere", box: { x: -5, y: 0, width: 10, height: 10 }, background: "red", lines: ["one\ntwo"], cut_off_lines: [4], first_line: 0 },
        { id: "ok", type: "code", parent: null, lines: "not a list" },
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const all = result.problems.join("\n");
    for (const problem of [/version must be 1/, /kind must be one of/, /id must be/, /type must be one of/, /0–1000 grid/, /background must be a hex color/,
      /without \\n inside/, /cut_off_lines must be line numbers from 1 to 1/, /first_line must be a whole number/, /lines must be a list/, /parent "nowhere" isn't a listed region/]) {
      expect(all).toMatch(problem);
    }
  });

  it("rejects text that isn't a report", () => {
    expect(parse("not json")).toMatchObject({ ok: false, problems: [expect.stringMatching(/isn't valid JSON/)] });
    expect(parse("[1, 2]")).toMatchObject({ ok: false, problems: ["The report must be one JSON object."] });
    expect(parse("x".repeat(1_000_001))).toMatchObject({ ok: false });
  });

  it("rejects regions whose parents loop", () => {
    const result = parse(report({ regions: [
      { id: "a", type: "content", parent: "b", lines: ["x"] },
      { id: "b", type: "content", parent: "a", lines: ["y"] },
    ] }));
    expect(result).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringMatching(/loop back/)]) });
  });

  it("checks a diagram's nodes and arrows, and requires one for diagram reports", () => {
    const diagram = { summary: "Login flow", nodes: [{ id: "a", label: "Start", shape: "start" }, { id: "b", label: "Log in", shape: "process" }], edges: [{ from: "a", to: "b", label: "" }] };
    const ok = parse(report({ kind: "diagram", application: "other", diagram, regions: [{ id: "d", type: "content", parent: null, lines: ["Start", "Log in"] }] }));
    expect(ok.ok && ok.report.diagram).toEqual(diagram);
    expect(parse(report({ kind: "diagram", application: "other" }))).toMatchObject({ ok: false, problems: [expect.stringMatching(/needs a diagram/)] });
    const broken = parse(report({ kind: "diagram", application: "other", diagram: { ...diagram, edges: [{ from: "a", to: "zz", label: "" }] } }));
    expect(broken).toMatchObject({ ok: false, problems: [expect.stringMatching(/isn't listed/)] });
  });

  it("warns about fields it doesn't know instead of failing", () => {
    const result = parse(report({ confidence: "high" }));
    expect(result.ok && result.warnings).toEqual(['Ignored unknown field "confidence".']);
  });

  it("joins the text in the order the report lists its regions", () => {
    const result = parse(report());
    expect(result.ok && reportText(result.report)).toBe('EXPLORER\n› docs\n{\n  "name": "imgtohtml-web",\n  "description": "Local app and Nod');
  });

  it("reads hex colors, short or long", () => {
    expect(hexColor("#ABC")).toBe("#aabbcc");
    expect(hexColor(" #1E1E1E ")).toBe("#1e1e1e");
    expect(hexColor("red")).toBeNull();
    expect(hexColor("#12345")).toBeNull();
  });
});
