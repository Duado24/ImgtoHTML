import { describe, expect, it } from "vitest";
import { buildModel } from "../src/core/model";
import { lookalikeFixes, mergeVision, onlyLookalikes } from "../src/core/vision";
import type { OcrWord } from "../src/core/types";

const word = (text: string, x: number, line: number): OcrWord => ({
  text, x, y: line * 20, width: 10 * text.length, height: 12, confidence: 95, block: 1, paragraph: 1, line,
});
const words = [word("git", 0, 0), word("log", 40, 0), word("--oneline", 80, 0), word("a1b2c3", 0, 1), word("Initial", 70, 1), word("commit", 150, 1)];
const model = () =>
  buildModel(300, 40, "diagram", { kind: "leaf", box: { x: 0, y: 0, width: 300, height: 40 }, background: [0, 0, 0], words }, words);

describe("mergeVision", () => {
  it("names regions and changes nothing where both sources agree", () => {
    const merged = mergeVision(model(), [{ regionId: "r1", role: "terminal", text: "git log --oneline\na1b2c3 Initial commit" }]);
    expect(merged.regions[0]!.role).toBe("terminal");
    expect(merged.regions[0]!.flags).toEqual([]);
    expect(merged.regions[0]!.lines.flatMap((l) => l.spans.map((s) => s.alternatives))).toEqual(Array(6).fill([]));
  });

  it("keeps the OCR text and adds the vision reading as an alternative where they differ", () => {
    const merged = mergeVision(model(), [{ regionId: "r1", role: "terminal", text: "git log --oneline\na1b2c3 lnitial commit" }]);
    const span = merged.regions[0]!.lines[1]!.spans[1]!;
    expect(span.text).toBe("Initial");
    expect(span.alternatives).toEqual([{ source: "vision", text: "lnitial", confidence: null }]);
    expect(merged.regions[0]!.flags).toEqual([
      { reason: "sources-disagree", spanId: "r1.l2.w2", detail: 'OCR read "Initial", vision model read "lnitial"' },
    ]);
    expect(merged.regions[0]!.review).toBe("pending");
  });

  it("matches lines even when the vision model orders or adds lines differently", () => {
    const merged = mergeVision(model(), [{ regionId: "r1", role: "text", text: "Terminal\na1b2c3 Initial commit\ngit log --oneline" }]);
    expect(merged.regions[0]!.flags).toEqual([]);
  });

  it("leaves lines alone when the vision model's text is unrelated", () => {
    const merged = mergeVision(model(), [{ regionId: "r1", role: "other", text: "something else entirely" }]);
    expect(merged.regions[0]!.flags).toEqual([]);
  });

  it("ignores readings for unknown regions", () => {
    expect(mergeVision(model(), [{ regionId: "r9", role: "code", text: "x" }])).toEqual(model());
  });
});

describe("lookalike corrections", () => {
  it("accepts swapped lookalike characters and one dropped dot", () => {
    expect(onlyLookalikes("HIML", "HTML")).toBe(true);
    expect(onlyLookalikes("packagejson", "package.json")).toBe(true);
    expect(onlyLookalikes("package,json", "package.json")).toBe(true);
    expect(onlyLookalikes("“dev”:", '"dev":')).toBe(false); // quote style isn't a lookalike: vision models straighten real curly quotes
  });
  it("leaves real disagreements for the reviewer", () => {
    expect(onlyLookalikes("Debug", "1")).toBe(false);
    expect(onlyLookalikes("cat", "car")).toBe(false);
    expect(onlyLookalikes("log", "logs")).toBe(false);
    expect(onlyLookalikes("HTML", "HTML")).toBe(false);
  });
  it("only fixes words OCR was unsure of", () => {
    const merged = mergeVision(model(), [{ regionId: "r1", role: "text", text: "git l0g --oneline\na1b2c3 Initial commit" }]);
    expect(lookalikeFixes(merged)).toEqual([]); // "log" was read at 95%
    const unsure = buildModel(300, 40, "diagram", { kind: "leaf", box: { x: 0, y: 0, width: 300, height: 40 }, background: [0, 0, 0], words: [{ ...words[0]!, text: "HIML", confidence: 60 }] }, [{ ...words[0]!, text: "HIML", confidence: 60 }]);
    const fixes = lookalikeFixes(mergeVision(unsure, [{ regionId: "r1", role: "text", text: "HTML" }]));
    expect(fixes).toEqual([{ box: expect.any(Object), from: "HIML", to: "HTML" }]);
  });

  it("does not complete text beyond a screenshot edge or automatically change its last word", () => {
    const boundary = word("Nod", 0, 0);
    const clipped = buildModel(300, 40, "code", { kind: "leaf", box: { x: 0, y: 0, width: 300, height: 40 }, background: [0, 0, 0], words: [boundary] }, [boundary]);
    const region = clipped.regions[0]!;
    const span = region.lines[0]!.spans[0]!;
    span.confidence = 0.5;
    region.flags.push({ reason: "cut-off", spanId: span.id, detail: "This line was cut off in the screenshot." });
    region.review = "pending";
    for (const completion of ["Node", "Nod."]) {
      const merged = mergeVision(clipped, [{ regionId: "r1", role: "code", text: completion }]);
      expect(merged.regions[0]!.lines[0]!.spans[0]!.alternatives).toEqual([]);
      expect(lookalikeFixes(merged)).toEqual([]);
    }
    const corrected = mergeVision(clipped, [{ regionId: "r1", role: "code", text: "N0d" }]);
    expect(corrected.regions[0]!.lines[0]!.spans[0]!.alternatives).toEqual([{ source: "vision", text: "N0d", confidence: null }]);
    expect(lookalikeFixes(corrected)).toEqual([]);
  });
});

describe("lookalike words on lines that don't line up", () => {
  const strip = [{ ...words[0]!, text: "Preview" }, { ...words[1]!, text: "packagejson", confidence: 90 }, { ...words[2]!, text: "ImgtoHTML" }];
  const tabs = () => buildModel(300, 40, "diagram", { kind: "leaf", box: { x: 0, y: 0, width: 300, height: 40 }, background: [0, 0, 0], words: strip }, strip);

  it("finds the one vision word that differs only by lookalikes", () => {
    // A tab bar read one tab per line: no line matches OCR's single line.
    const merged = mergeVision(tabs(), [{ regionId: "r1", role: "tabs", text: "Preview\n{ } package.json  X\n🌐 ImgtoHTML" }]);
    const span = merged.regions[0]!.lines[0]!.spans[1]!;
    expect(span.alternatives).toEqual([{ source: "vision", text: "package.json", confidence: null }]);
    expect(lookalikeFixes(merged).map((f) => f.to)).toEqual(["package.json"]);
  });
  it("offers nothing when more than one vision word fits", () => {
    const merged = mergeVision(tabs(), [{ regionId: "r1", role: "tabs", text: "Preview\npackage.json package,json\nImgtoHTML" }]);
    expect(merged.regions[0]!.lines[0]!.spans[1]!.alternatives).toEqual([]);
  });
});
