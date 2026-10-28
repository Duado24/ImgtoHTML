import { describe, it, expect } from "vitest";
import fixture from "./fixtures/vscode-package-json.layout.json";
import { validateLayout, checkLayout, fromNormalized, assignLayoutWords, renderLayout, refineLayout } from "../src/core/vision-layout";
import { convert } from "../src/core/convert";
import { checkCanvasSafe } from "../src/core/canvas";
import type { OcrWord } from "../src/core/types";
const layout = validateLayout(fixture, 1033, 367)!;
const word = (text: string, x: number, y: number): OcrWord => ({ text, x, y, width: 60, height: 12, confidence: 99, block: 1, paragraph: 1, line: 1 });
const words = [word("Explorer", 5, 5), word("package.json", 480, 5), word('"name":', 380, 68), word("/home/alice/file", 15, 65)];
describe("vision layout", () => {
  it("assigns Explorer and code to independent components exactly once", () => {
    const assigned = assignLayoutWords(layout, words);
    expect(assigned.get("explorer")?.map((w) => w.text)).toContain("Explorer");
    expect(assigned.get("code")?.map((w) => w.text)).toEqual(['"name":']);
    expect([...assigned.values()].flat()).toHaveLength(words.length);
  });
  it("rejects cycles, missing parents, duplicate IDs, invalid bounds and sibling overlap", () => {
    for (const mutate of [
      (v: typeof fixture) => { v.components[0]!.parent = "explorer"; },
      (v: typeof fixture) => { v.components[0]!.parent = "missing"; },
      (v: typeof fixture) => { v.components[1]!.id = "explorer"; },
      (v: typeof fixture) => { v.components[0]!.box.width = -1; },
      (v: typeof fixture) => { v.components[0]!.box.width = 500; },
    ]) { const v = structuredClone(fixture); mutate(v); expect(validateLayout(v, 1033, 367)).toBeNull(); }
  });
  it("names the first problem in a rejected layout", () => {
    const v = structuredClone(fixture);
    v.components[0]!.parent = "missing";
    expect(checkLayout(v, 1033, 367).problem).toBe("explorer: missing parent missing");
    expect(checkLayout(fixture, 1033, 367).problem).toBeNull();
  });
  it("scales Qwen's 0–1000 boxes to pixels, which a small image would otherwise reject", () => {
    // Shaped like qwen3-vl's answer for a 387×314 GitHub Classroom screenshot
    // (there, "main" also overlapped "header" by 17/1000; moved down here).
    const answer = { application: "website", components: [
      { id: "header", type: "toolbar", parent: null, box: { x: 0, y: 17, width: 999, height: 120 } },
      { id: "main", type: "container", parent: null, box: { x: 0, y: 137, width: 999, height: 853 } },
      { id: "body", type: "content", parent: "main", box: { x: 160, y: 340, width: 839, height: 530 } },
    ] };
    expect(checkLayout(answer, 387, 314).problem).toBe("body: box starts outside the 387×314 image");
    const scaled = checkLayout(fromNormalized(answer, 387, 314), 387, 314);
    expect(scaled.problem).toBeNull();
    expect(scaled.layout!.components[1]!.box).toMatchObject({ x: 0, y: expect.closeTo(43, 0), width: expect.closeTo(386.6, 0) });
  });
  it("says why a layout wasn't used", () => {
    const pixels = { width: 1033, height: 367, data: new Uint8ClampedArray(1033 * 367 * 4).fill(30) };
    const status = (extra: object) => convert({ fileName: "ide.png", pixels, words, animated: false, kind: "terminal", ...extra }).review.layout_status;
    expect(status({ layout })).toMatchObject({ renderer: "layout", application: "ide", reason: null });
    expect(status({})).toMatchObject({ renderer: "rows", reason: "no layout was detected" });
    expect(status({ layout, editorWindow: false })).toMatchObject({ renderer: "rows", reason: "the editor window option is off" });
    expect(status({ layout: { ...layout, application: "terminal" } })).toMatchObject({ renderer: "rows", application: "terminal", reason: '"terminal" screenshots use the terminal renderer' });
  });
  it("corrects terminal classification for an IDE, preserves privacy and emits Canvas-safe inline tables", () => {
    const pixels = { width: 1033, height: 367, data: new Uint8ClampedArray(1033 * 367 * 4).fill(30) };
    const result = convert({ fileName: "ide.png", pixels, words, animated: false, kind: "terminal", layout });
    expect(result.review.type).toBe("interface");
    expect(result.html).toContain('<table role="presentation"');
    expect(result.html).toContain('id="layout-explorer"');
    expect(result.html).toContain('id="layout-code"');
    expect(result.html).not.toContain("alice");
    expect(checkCanvasSafe(result.html)).toEqual([]);
    expect(convert({ fileName: "ide.png", pixels, words, animated: false, kind: "terminal", layout, transcript: "verified text" }).html).not.toContain("layout-explorer");
  });
  it("retains OCR words outside model rectangles without inventing text", () => {
    const html = renderLayout(layout, [...words, word("outside", 1100, 0)], 1033, "IDE", null, (ws) => ws.map((w) => w.text).join(" "));
    expect(html.match(/outside/g)).toHaveLength(1);
    expect(html).not.toContain("invented");
  });
});

it("snaps a model column boundary to a strong source separator", () => {
  const data = new Uint8ClampedArray(100 * 50 * 4);
  for (let y = 0; y < 50; y++) for (let x = 32; x < 100; x++) data.fill(100, (y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
  const approximate = validateLayout({ application: "ide", components: [
    { id: "side", type: "sidebar", parent: null, box: { x: 0, y: 0, width: 28, height: 50 } },
    { id: "edit", type: "editor", parent: null, box: { x: 28, y: 0, width: 72, height: 50 } },
  ] }, 100, 50)!;
  const refined = refineLayout(approximate, { width: 100, height: 50, data });
  expect(refined.components[0]!.box.width).toBe(32);
  expect(refined.components[1]!.box.x).toBe(32);
});
