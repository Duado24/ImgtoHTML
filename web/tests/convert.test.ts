import { describe, expect, it } from "vitest";
import { convert, issuesFor, previewPage, splitName } from "../src/core/convert";
import type { OcrWord, RGB } from "../src/core/types";
import { FakeImage } from "./image";

const DARK: RGB = [0x1e, 0x1e, 0x1e];
const TEXT: RGB = [0xd4, 0xd4, 0xd4];

const word = (text: string, x: number, y: number, width: number, confidence = 96, line = 0): OcrWord => ({
  text, confidence, block: 0, paragraph: 0, line, x, y, width, height: 14,
});

/** A fake terminal: two "words" drawn as solid blocks, with OCR boxes on them. */
function terminal() {
  const pixels = new FakeImage(300, 80, DARK);
  pixels.fill(10, 10, 89, 23, TEXT);
  pixels.fill(100, 10, 149, 23, TEXT);
  const words = [word("/home/duado24/app", 10, 10, 80), word("ok", 100, 10, 50, 52)];
  return { pixels, words };
}

/** A fake editor: sidebar | separator line | editor with yellow and gray text. */
function editor() {
  const pixels = new FakeImage(400, 120, [0x18, 0x18, 0x18]);
  pixels.fill(120, 0, 120, 119, [0x2b, 0x2b, 0x2b]); // vertical separator
  pixels.fill(10, 10, 89, 23, [0xcc, 0xcc, 0xcc]); // "Explorer"
  pixels.fill(140, 10, 179, 23, [0xdc, 0xdc, 0xaa]); // "print"
  pixels.fill(182, 10, 189, 23, [0xcc, 0xcc, 0xcc]); // "("
  const words: OcrWord[] = [
    word("Explorer", 10, 10, 80),
    {
      ...word("print(", 140, 10, 50),
      symbols: [
        ...[..."print"].map((c, i) => ({ text: c, x: 140 + 8 * i, y: 10, width: 8, height: 14 })),
        { text: "(", x: 182, y: 10, width: 8, height: 14 },
      ],
    },
  ];
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
    expect(result.html).toContain("/home/username/app");
    expect(result.html).toContain('aria-label="Terminal output"');
    expect(result.lowConfidenceCount).toBe(1);
    expect(JSON.parse(result.reviewFile.content)).toEqual(result.review);
  });

  it("keeps the screenshot's own background and text colors outside the course theme", () => {
    const { pixels, words } = terminal();
    const { review, html } = convert({ fileName: "a.png", pixels, words, animated: false, kind: "diagram" });
    expect(review.original_colors.background).toBe("#1e1e1e");
    expect(html).toContain("background-color:#1e1e1e");
    expect(html).toContain("color:#d4d4d4");
  });

  it("pale text on white is darkened to 4.5:1", () => {
    const pixels = new FakeImage(200, 40, [0xff, 0xff, 0xff]);
    pixels.fill(10, 10, 99, 23, [0x99, 0x99, 0x99]);
    const { review } = convert({
      fileName: "a.png", pixels, words: [word("hello", 10, 10, 90)], animated: false, kind: "diagram",
    });
    expect(review.contrast_ratio).toBeGreaterThanOrEqual(4.5);
    expect(review.contrast_changes).toHaveLength(1);
  });

  it("letters keep their own colors (syntax highlighting) outside the course theme", () => {
    const { pixels, words } = editor();
    const { html, review } = convert({ fileName: "a.png", pixels, words, animated: false, kind: "diagram" });
    expect(html).toContain('<span style="color:#dcdcaa;">print</span>(');
    expect(review.colors_used).toEqual(expect.arrayContaining(["#cccccc", "#dcdcaa"]));
  });

  it("code uses the course theme and is highlighted by language", () => {
    const { pixels, words } = editor();
    const transcript = "def greet(name):\n    # say hello\n    return f\"Hello {name}\"\n\nprint(greet('class'))";
    const { html, review } = convert({ fileName: "a.png", pixels, words, animated: false, kind: "code", transcript });
    expect(review.theme).toBe("vscode-dark-code");
    expect(review.code?.language).toBe("python");
    expect(html).toContain("background-color:#1e1e1e;color:#d4d4d4;");
    expect(html).toContain('<span style="color:#569cd6;">def</span>');
    expect(html).toContain('<span style="color:#dcdcaa;">greet</span>');
    expect(html).toContain('<span style="color:#6a9955;"># say hello</span>');
    expect(review.contrast_changes).toEqual([]);
    expect(review.check_colors_by_hand).toBe(false);
  });

  it("UI type rebuilds panels split by separator lines", () => {
    const { pixels, words } = editor();
    const result = convert({ fileName: "a.png", pixels, words, animated: false, kind: "interface" });
    expect(result.review.panels).toBe(2);
    expect(result.html).toContain("display:flex;flex-wrap:wrap;");
    expect(result.html).toContain("border-right:1px solid #2b2b2b;");
    expect(result.html).toContain("Explorer");
  });

  it("other types point out that panels were found", () => {
    const { pixels, words } = editor();
    const result = convert({ fileName: "a.png", pixels, words, animated: false, kind: "terminal" });
    expect(issuesFor(result).map((i) => i.text).join(" ")).toContain("Choose type UI");
  });

  it("a corrected transcript replaces the OCR text (one color)", () => {
    const { pixels, words } = terminal();
    const result = convert({
      fileName: "a.png", pixels, words, animated: false, kind: "code",
      transcript: "line one\r\nC:\\Users\\mirca\\x",
    });
    expect(result.transcript).toBe("line one\nC:\\Users\\username\\x");
    expect(result.lowConfidenceCount).toBe(0);
    expect(result.fromTranscript).toBe(true);
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
