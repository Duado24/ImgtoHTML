import { describe, expect, it } from "vitest";
import { normalize, scoreLayout, scoreText, unsupportedWords } from "../src/core/metrics";

describe("scoreText", () => {
  it("scores an exact match as perfect, ignoring trailing spaces and line endings", () => {
    expect(scoreText("ls -la\r\n  total 8  \r\n\r\n", "ls -la\n  total 8")).toEqual({
      cer: 0,
      cerIgnoringSpaces: 0,
      lineAccuracy: 1,
      lineAccuracyIgnoringSpaces: 1,
      confusable: [],
    });
  });

  it("separates spacing errors from letter errors", () => {
    const score = scoreText("a  b", "a b");
    expect(score.cer).toBeCloseTo(1 / 4);
    expect(score.cerIgnoringSpaces).toBe(0);
  });

  it("treats indentation, column gaps and blank lines as spacing", () => {
    const score = scoreText("OS Customisation\nGENERAL  SERVICES\nSAVE", "   OS Customisation\n\n\n  GENERAL        SERVICES\n\n          SAVE");
    expect(score.cer).toBeGreaterThan(0.5);
    expect(score.cerIgnoringSpaces).toBe(0);
    expect(score.lineAccuracy).toBe(0);
    expect(score.lineAccuracyIgnoringSpaces).toBe(1);
  });

  it("lists confusable-character edits", () => {
    const score = scoreText("ls -l\necho 'hi'", "1s —l\necho `hi'");
    expect(score.confusable).toEqual(["l→1", "-→—", "'→`"]);
    expect(score.lineAccuracy).toBe(0);
  });

  it("keeps indentation", () => {
    expect(normalize("def f():\n    return 1\n")).toBe("def f():\n    return 1");
  });
});

describe("scoreLayout", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const marked = [{ type: "sidebar", box: box(0, 0, 100, 100) }, { type: "code", box: box(100, 0, 100, 100) }];

  it("scores each marked component by its best same-type overlap", () => {
    const score = scoreLayout([{ type: "sidebar", box: box(0, 0, 100, 100) }, { type: "code", box: box(150, 0, 50, 100) }], marked);
    expect(score.components).toEqual([{ type: "sidebar", iou: 1 }, { type: "code", iou: 0.5 }]);
    expect(score.meanIoU).toBe(0.75);
  });
  it("scores 0 without a layout or a component of that type", () => {
    expect(scoreLayout(null, marked).meanIoU).toBe(0);
    expect(scoreLayout([{ type: "editor", box: box(100, 0, 100, 100) }], marked).components[1]!.iou).toBe(0);
  });
});

describe("unsupportedWords", () => {
  const ocr = ["“name”:", '"imgtohtml-web",', "Nod", '""vitest'];

  it("finds words the screenshot doesn't show", () => {
    const html = '<div><span>"name"</span>: <span>"imgtohtml-web",</span></div><div>Nod server",</div>';
    expect(unsupportedWords(html, ocr)).toEqual(['server",']);
  });
  it("decodes numeric entities before comparing", () => {
    expect(unsupportedWords("<div>Let&#x27;s go&#39;</div>", ["Let's", "go'"])).toEqual([]);
  });
  it("ignores quote clean-up, punctuation, numbers and markup", () => {
    const html = '<table><tr><td aria-hidden="true">12</td><td>&quot;vitest {</td></tr></table><div>› ⌄ }</div>';
    expect(unsupportedWords(html, ocr)).toEqual([]);
  });
});
