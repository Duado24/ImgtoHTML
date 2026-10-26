import { describe, expect, it } from "vitest";
import { inkImage, ocrScale } from "../src/core/preprocess";
import { segment } from "../src/core/regions";
import type { OcrWord, RGB } from "../src/core/types";
import { FakeImage } from "./image";

const BG: RGB = [0x18, 0x18, 0x18];
const LINE: RGB = [0x2b, 0x2b, 0x2b];

const word = (x: number, y: number): OcrWord => ({
  text: "word", confidence: 99, block: 0, paragraph: 0, line: 0, x, y, width: 30, height: 12,
});

/** Sidebar | editor over terminal, like VS Code. */
function vscode() {
  const img = new FakeImage(400, 200, BG);
  img.fill(100, 0, 100, 199, LINE); // sidebar border
  img.fill(101, 120, 399, 120, LINE); // terminal panel top border
  img.fill(101, 121, 399, 199, [0x1f, 0x1f, 0x1f]);
  return img;
}

describe("panels", () => {
  it("splits sidebar | (editor / terminal)", () => {
    const tree = segment(vscode(), [word(10, 10), word(120, 10), word(120, 140)]);
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") return;
    expect(tree.direction).toBe("row");
    expect(tree.separator).toEqual(LINE);
    expect(tree.children.map((c) => c.box.width)).toEqual([100, 299]);

    const right = tree.children[1]!;
    expect(right.kind).toBe("split");
    if (right.kind !== "split") return;
    expect(right.direction).toBe("column");
    expect(right.children.map((c) => c.kind)).toEqual(["leaf", "leaf"]);
    expect(right.children[1]!.background).toEqual([0x1f, 0x1f, 0x1f]);
  });

  it("words go to the panel they are in", () => {
    const tree = segment(vscode(), [word(10, 10), word(120, 140)]);
    if (tree.kind !== "split") throw new Error("expected a split");
    const [left, right] = tree.children;
    expect(left!.kind === "leaf" && left!.words.length).toBe(1);
    expect(right!.kind === "split" && right!.children[1]!.kind === "leaf" && right!.children[1]!.words.length).toBe(1);
  });

  it("a line that would cut through a word is not a separator", () => {
    const img = new FakeImage(300, 100, BG);
    img.fill(150, 0, 150, 99, LINE);
    expect(segment(img, [word(140, 40)]).kind).toBe("leaf");
  });

  it("plain terminal: one panel", () => {
    expect(segment(new FakeImage(300, 100, BG), [word(10, 10)]).kind).toBe("leaf");
  });
});

describe("OCR preprocessing", () => {
  it("background turns white, any text color turns dark", () => {
    const img = new FakeImage(3, 1, BG);
    img.set(1, 0, [0xcc, 0xcc, 0xcc]); // light gray text
    img.set(2, 0, [0x85, 0x85, 0x85]); // dim gray label
    const ink = inkImage(img, BG);
    expect([ink.data[0], ink.data[4], ink.data[8]]).toEqual([255, 0, 37]); // 255 - 2 × (0x85 - 0x18)
  });

  it("enlarges 3×, but not past 4500 px", () => {
    expect(ocrScale(1147, 263)).toBe(3);
    expect(ocrScale(3000, 1000)).toBe(1.5);
    expect(ocrScale(6000, 100)).toBe(1);
  });
});
