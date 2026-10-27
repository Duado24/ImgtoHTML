import { describe, expect, it } from "vitest";
import { addVision, convert } from "../src/core/convert";
import { FakeImage } from "./image";
import type { OcrWord } from "../src/core/types";

const word = (text: string, x: number, line: number): OcrWord => ({
  text, x, y: 10 + line * 20, width: 9 * text.length, height: 12, confidence: 95, block: 1, paragraph: 1, line,
});

describe("addVision", () => {
  it("masks usernames in the vision model's text, as OCR text is masked", () => {
    const pixels = new FakeImage(400, 60, [30, 30, 30]);
    const words = [word("C:\\Users\\moori\\cs104>", 10, 0), word("got", 10, 1), word("moori@MDesktop", 50, 1)];
    const result = convert({ fileName: "a.png", pixels, words, animated: false, kind: "terminal" });
    const withVision = addVision(result, "test", [
      { regionId: "r1", role: "terminal", text: "C:\\Users\\moori\\cs104>\ngot moori@MDesktop" },
    ]);
    expect(withVision.modelFile.content).not.toContain("moori");
    expect(withVision.reviewFile.content).not.toContain("moori");
    expect(withVision.review.vision).toEqual({ model: "test", regions_read: 1 });
  });
});
