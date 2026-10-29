import { describe, expect, it } from "vitest";
import { buildModel, countWordsToCheck, flagsByRegion } from "../src/core/model";
import type { Leaf, Region } from "../src/core/regions";
import type { OcrWord } from "../src/core/types";

const word = (text: string, x: number, y: number, confidence: number, line = 1): OcrWord => ({
  text, x, y, width: 10 * text.length, height: 12, confidence, block: 1, paragraph: 1, line,
});
const leaf = (x: number, words: OcrWord[]): Leaf => ({
  kind: "leaf", box: { x, y: 0, width: 200, height: 100 }, background: [0, 0, 0], words,
});

describe("buildModel", () => {
  const left = [word("git", 0, 0, 96), word("status", 40, 0, 95), word("On", 0, 20, 50, 2)];
  const right = [word("Iog", 210, 0, 80)];
  const tree: Region = {
    kind: "split", box: { x: 0, y: 0, width: 410, height: 100 }, background: [0, 0, 0],
    direction: "row", separator: [9, 9, 9], children: [leaf(0, left), leaf(210, right)],
  };

  it("gives position-based IDs to regions, lines and spans", () => {
    const model = buildModel(410, 100, "terminal", tree, [...left, ...right]);
    expect(model.regions.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(model.regions[0]!.lines.map((l) => l.spans.map((s) => `${s.id}=${s.text}`))).toEqual([
      ["r1.l1.w1=git", "r1.l1.w2=status"],
      ["r1.l2.w1=On"],
    ]);
    expect(model.regions[0]!.lines[0]!.spans[0]).toMatchObject({ source: "ocr", confidence: 0.96, alternatives: [] });
  });

  it("weights region confidence by letters and flags what needs review", () => {
    const [r1, r2] = buildModel(410, 100, "terminal", tree, [...left, ...right]).regions;
    expect(r1!.confidence).toBeCloseTo((3 * 0.96 + 6 * 0.95 + 2 * 0.5) / 11, 3);
    expect(r1!.flags).toEqual([{ reason: "low-confidence", spanId: "r1.l2.w1", detail: "OCR confidence 50%" }]);
    expect(r2!.flags.map((f) => f.reason)).toEqual(["confusable"]);
    expect([r1!.review, r2!.review]).toEqual(["pending", "pending"]);
  });

  it("only checks lookalike characters in terminals and code", () => {
    const model = buildModel(410, 100, "diagram", tree, [...left, ...right]);
    expect(model.regions[1]!.flags).toEqual([]);
    expect(model.regions[1]!.review).toBe("approved");
  });

  it("keeps words outside every panel in a last region", () => {
    const stray = word("stray", 205, 50, 99);
    const model = buildModel(410, 100, "terminal", tree, [...left, ...right, stray]);
    expect(model.regions.at(-1)).toMatchObject({ id: "r3", box: { x: 0, y: 0, width: 410, height: 100 } });
  });

  it("lists flagged regions least confident first", () => {
    const model = buildModel(410, 100, "terminal", tree, [...left, ...right]);
    expect(flagsByRegion(model).map((r) => r.region)).toEqual(["r2", "r1"]);
  });

  it("counts only flagged words in regions still waiting for review", () => {
    const model = buildModel(410, 100, "terminal", tree, [...left, ...right]);
    // "On" (blurry) and "Iog" (lookalikes); "git" and "status" were read clearly.
    expect(countWordsToCheck(model)).toBe(2);
    model.regions[0]!.review = "approved";
    expect(countWordsToCheck(model)).toBe(1);
    model.regions[1]!.review = "corrected";
    expect(countWordsToCheck(model)).toBe(0);
  });
});
