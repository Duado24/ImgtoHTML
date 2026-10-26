import { describe, expect, it } from "vitest";
import { layoutWords } from "../src/core/layout";
import type { OcrWord } from "../src/core/types";

/** Simulated OCR words: [text, left, top, width]; 12 px tall,
 *  line 1 at top 0, line 2 below. */
function words(list: [string, number, number, number][]): OcrWord[] {
  return list.map(([text, x, y, width]) => ({
    text,
    confidence: 99,
    block: 1,
    paragraph: 1,
    line: y === 0 ? 1 : 2,
    x,
    y,
    width,
    height: 12,
  }));
}

const lines = (list: [string, number, number, number][]) => layoutWords(words(list)).lines;

describe("spacing", () => {
  it("normal sentence", () => {
    expect(lines([["Welcome", 0, 0, 56], ["to", 64, 0, 16], ["VitalLink", 88, 0, 72]])).toEqual([
      "Welcome to VitalLink",
    ]);
  });

  it("no extra space", () => {
    expect(lines([["signed", 0, 0, 48], ["up", 56, 0, 16]])).toEqual(["signed up"]);
  });

  it("wide gap preserved", () => {
    expect(lines([["signed", 0, 0, 48], ["up", 80, 0, 16]])).toEqual(["signed    up"]);
  });

  it("two spaces preserved", () => {
    expect(lines([["signed", 0, 0, 48], ["up", 64, 0, 16]])).toEqual(["signed  up"]);
  });

  it("single spaces calibrated", () => {
    expect(
      lines([
        ["print", 0, 0, 40],
        ["the", 51, 0, 24],
        ["total", 86, 0, 40],
        ["of", 137, 0, 16],
        ["all", 164, 0, 24],
        ["items", 199, 0, 40],
        ["x", 0, 20, 8],
        ["=", 19, 20, 8],
        ["1", 38, 20, 8],
        ["#", 65, 20, 8],
        ["note", 84, 20, 32],
      ]),
    ).toEqual(["print the total of all items", "x = 1  # note"]);
  });

  it("blank lines from vertical gaps, indentation from left edge", () => {
    const result = layoutWords([
      { text: "def", confidence: 99, block: 1, paragraph: 1, line: 1, x: 0, y: 0, width: 24, height: 12 },
      { text: "f():", confidence: 99, block: 1, paragraph: 1, line: 1, x: 32, y: 0, width: 32, height: 12 },
      { text: "return", confidence: 99, block: 1, paragraph: 2, line: 1, x: 32, y: 54, width: 48, height: 12 },
    ]);
    expect(result.lines).toEqual(["def f():", "", "", "    return"]);
  });

  it("low-confidence words are listed", () => {
    const result = layoutWords([
      { text: "sure", confidence: 95, block: 1, paragraph: 1, line: 1, x: 0, y: 0, width: 32, height: 12 },
      { text: "maybe", confidence: 41.5, block: 1, paragraph: 1, line: 1, x: 40, y: 0, width: 40, height: 12 },
    ]);
    expect(result.uncertain).toEqual([{ text: "maybe", confidence: 41.5 }]);
  });

  it("no words, no lines", () => {
    expect(layoutWords([])).toEqual({ lines: [], rows: [], uncertain: [], boxes: [] });
  });
});
