import { describe, expect, it } from "vitest";
import { buildModel } from "../src/core/model";
import { mergeVision } from "../src/core/vision";
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
