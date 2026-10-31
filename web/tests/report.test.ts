import { describe, expect, it } from "vitest";
import { parseReport, reportText } from "../src/core/report";

const report = (over: Record<string, unknown> = {}) => ({
  format: "imgtohtml-report", version: 1, kind: "code", application: "ide", language: "json",
  regions: [
    { id: "files", type: "sidebar", parent: null, box: { x: 0, y: 0, width: 200, height: 1000 }, lines: ["EXPLORER", "> docs"] },
    { id: "code", type: "code", parent: null, box: { x: 200, y: 0, width: 800, height: 1000 },
      lines: ["{", '  "name": "imgtohtml-web",', '  "description": "Local app and Nod'], cut_off_lines: [3], unsure_words: ["Nod"] },
  ],
  ...over,
});
const parse = (value: unknown, w = 2000, h = 500) => parseReport(typeof value === "string" ? value : JSON.stringify(value), w, h);

describe("screenshot reports", () => {
  it("converts a valid report into a layout and readings in image pixels", () => {
    const result = parse(report());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.layout?.components.map((c) => [c.id, c.type, c.box])).toEqual([
      ["files", "sidebar", { x: 0, y: 0, width: 400, height: 500 }],
      ["code", "code", { x: 400, y: 0, width: 1600, height: 500 }],
    ]);
    // Leading spaces are text: they survive into the reading.
    expect(result.value.readings[1]).toEqual({ box: { x: 400, y: 0, width: 1600, height: 500 }, role: "code", text: '{\n  "name": "imgtohtml-web",\n  "description": "Local app and Nod' });
    expect(result.value.report.regions[1]!.cut_off_lines).toEqual([3]);
    expect(result.value.warnings).toEqual([]);
  });

  it("accepts the JSON inside a ```json fence, as chat assistants hand it over", () => {
    expect(parse("Here is the report:\n```json\n" + JSON.stringify(report()) + "\n```\n").ok).toBe(true);
  });

  it("lists every problem at once, so they can all go back to the AI in one message", () => {
    const result = parse(report({
      version: 2, kind: "photo",
      regions: [
        { id: "a b", type: "window", parent: "nowhere", box: { x: -5, y: 0, width: 10, height: 10 }, lines: ["one\ntwo"], cut_off_lines: [4] },
        { id: "ok", type: "code", parent: null, lines: "not a list" },
      ],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("\n")).toMatch(/version must be 1/);
    expect(result.problems.join("\n")).toMatch(/kind must be one of/);
    expect(result.problems.join("\n")).toMatch(/id must be/);
    expect(result.problems.join("\n")).toMatch(/type must be one of/);
    expect(result.problems.join("\n")).toMatch(/0–1000 grid/);
    expect(result.problems.join("\n")).toMatch(/without \\n inside/);
    expect(result.problems.join("\n")).toMatch(/cut_off_lines must be line numbers from 1 to 1/);
    expect(result.problems.join("\n")).toMatch(/lines must be a list/);
    expect(result.problems.join("\n")).toMatch(/parent "nowhere" isn't a listed region/);
  });

  it("rejects text that isn't a report", () => {
    expect(parse("not json")).toMatchObject({ ok: false, problems: [expect.stringMatching(/isn't valid JSON/)] });
    expect(parse("[1, 2]")).toMatchObject({ ok: false, problems: ["The report must be one JSON object."] });
    expect(parse("x".repeat(1_000_001))).toMatchObject({ ok: false });
  });

  it("keeps the text when the regions can't form a layout, and says why", () => {
    const result = parse(report({ regions: [
      { id: "left", type: "content", parent: null, box: { x: 0, y: 0, width: 600, height: 1000 }, lines: ["a"] },
      { id: "right", type: "content", parent: null, box: { x: 400, y: 0, width: 600, height: 1000 }, lines: ["b"] },
    ] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.layout).toBeNull();
    expect(result.value.layoutProblem).toMatch(/overlap/);
    expect(result.value.readings.map((r) => r.text)).toEqual(["a", "b"]);
  });

  it("treats a region without a box as the whole screenshot", () => {
    const result = parse(report({ kind: "terminal", application: "terminal", regions: [{ id: "t", type: "terminal", parent: null, lines: ["$ ls"] }] }));
    expect(result.ok && result.value.readings[0]!.box).toEqual({ x: 0, y: 0, width: 2000, height: 500 });
  });

  it("checks a diagram's nodes and arrows, and requires one for diagram reports", () => {
    const diagram = { summary: "Login flow", nodes: [{ id: "a", label: "Start", shape: "start" }, { id: "b", label: "Log in", shape: "process" }], edges: [{ from: "a", to: "b", label: "" }] };
    const ok = parse(report({ kind: "diagram", application: "other", diagram, regions: [{ id: "d", type: "content", parent: null, lines: ["Start", "Log in"] }] }));
    expect(ok.ok && ok.value.diagram).toEqual(diagram);
    const missing = parse(report({ kind: "diagram", application: "other" }));
    expect(missing).toMatchObject({ ok: false, problems: [expect.stringMatching(/needs a diagram/)] });
    const broken = parse(report({ kind: "diagram", application: "other", diagram: { ...diagram, edges: [{ from: "a", to: "zz", label: "" }] } }));
    expect(broken).toMatchObject({ ok: false, problems: [expect.stringMatching(/isn't listed/)] });
  });

  it("warns about fields it doesn't know instead of failing", () => {
    const result = parse(report({ confidence: "high" }));
    expect(result.ok && result.value.warnings).toEqual(['Ignored unknown field "confidence".']);
  });

  it("joins the text in the order the report lists its regions", () => {
    const result = parse(report());
    expect(result.ok && reportText(result.value.report)).toBe('EXPLORER\n> docs\n{\n  "name": "imgtohtml-web",\n  "description": "Local app and Nod');
  });
});
