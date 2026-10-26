import { describe, expect, it } from "vitest";
import { convert, issuesFor, previewPage, splitName } from "../src/core/convert";
import type { OcrWord, RGB } from "../src/core/types";
import { FakeImage } from "./image";

const DARK: RGB = [0x1e, 0x1e, 0x1e];
const TEXT: RGB = [0xd4, 0xd4, 0xd4];

/** A fake terminal: two "words" drawn as solid blocks, with OCR boxes on them. */
function terminal() {
  const pixels = new FakeImage(300, 80, DARK);
  pixels.fill(10, 10, 89, 23, TEXT);
  pixels.fill(100, 10, 149, 23, TEXT);
  const word = (text: string, x: number, width: number, confidence = 96): OcrWord => ({
    text, confidence, block: 0, paragraph: 0, line: 0, x, y: 10, width, height: 14,
  });
  const words = [word("/home/duado24/app", 10, 80), word("ok", 100, 50, 52)];
  return { pixels, words };
}

describe("convert", () => {
  it("builds the Canvas HTML, transcript and review", () => {
    const { pixels, words } = terminal();
    const result = convert({
      fileName: "Screenshot 2026-10-23 124247.PNG",
      pixels, words, animated: false, kind: "terminal", label: "Terminal output",
    });

    expect(result.htmlFile.name).toBe("Media_Screenshot_2026-10-23_124247.png.html");
    expect(result.transcriptFile.name).toBe("Screenshot_2026-10-23_124247_transcript.txt");
    expect(result.reviewFile.name).toBe("Screenshot_2026-10-23_124247_review.json");
    expect(result.transcript).toContain("/home/username/app");
    expect(result.html).toContain('aria-label="Terminal output"');
    expect(result.lowConfidenceCount).toBe(1);
    expect(JSON.parse(result.reviewFile.content)).toEqual(result.review);
  });

  it("box background is pure black for a dark screenshot", () => {
    const { pixels, words } = terminal();
    const { review, html } = convert({ fileName: "a.png", pixels, words, animated: false, kind: "terminal" });
    expect(review.original_colors.background).toBe("#1e1e1e");
    expect(review.rendered_colors.background).toBe("#000000");
    expect(review.rendered_colors.foreground).toBe("#d4d4d4");
    expect(html).toContain("background-color:#000000");
    expect(issuesFor(review).map((i) => i.text)).toContain("Background #1e1e1e shown as #000000.");
  });

  it("box background is pure white for a light screenshot, text darkened if needed", () => {
    const pixels = new FakeImage(200, 40, [0xfa, 0xfa, 0xfa]);
    pixels.fill(10, 10, 99, 23, [0x99, 0x99, 0x99]); // too pale to read on white
    const words: OcrWord[] = [
      { text: "hello", confidence: 99, block: 0, paragraph: 0, line: 0, x: 10, y: 10, width: 90, height: 14 },
    ];
    const { review } = convert({ fileName: "a.png", pixels, words, animated: false, kind: "terminal" });
    expect(review.rendered_colors.background).toBe("#ffffff");
    expect(review.contrast_ratio).toBeGreaterThanOrEqual(4.5);
    expect(review.contrast_changes).toHaveLength(1);
  });

  it("a corrected transcript replaces the OCR text", () => {
    const { pixels, words } = terminal();
    const result = convert({
      fileName: "a.png", pixels, words, animated: false, kind: "code",
      transcript: "line one\r\nline two",
    });
    expect(result.transcript).toBe("line one\nline two");
    expect(result.lowConfidenceCount).toBe(0);
    expect(result.review.check_colors_by_hand).toBe(true); // always for code
  });

  it("blank label and caption mean 'not given'; GIFs get the animation note", () => {
    const { pixels, words } = terminal();
    const result = convert({
      fileName: "demo.gif", pixels, words, animated: true, kind: "terminal", label: "  ", caption: "",
    });
    expect(result.html).toContain('aria-label="Terminal screenshot showing the content of demo"');
    expect(result.html).toContain("This reconstruction shows the final frame.");
  });

  it("comparison page embeds the screenshot and the draft", () => {
    const { pixels, words } = terminal();
    const result = convert({ fileName: "a.png", pixels, words, animated: false, kind: "terminal" });
    const page = previewPage(result, "data:image/png;base64,AAAA");
    expect(page.name).toBe("a_preview.html");
    expect(page.content).toContain('src="data:image/png;base64,AAAA"');
    expect(page.content).toContain(result.html);
  });

  it("file names split like pathlib", () => {
    expect(splitName("C:\\shots\\x.y.GIF")).toEqual({ stem: "x.y", suffix: ".gif" });
    expect(splitName(".bashrc")).toEqual({ stem: ".bashrc", suffix: "" });
  });
});
