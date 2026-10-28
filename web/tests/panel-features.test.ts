import { describe, expect, it } from "vitest";
import { measureFont, MONO_FONT, UI_FONT, splitItems, chromeNoise, treeArrows } from "../src/core/panel-features";
import { convert } from "../src/core/convert";
import { checkCanvasSafe } from "../src/core/canvas";
import { validateLayout } from "../src/core/vision-layout";
import fixture from "./fixtures/vscode-package-json.layout.json";
import { FakeImage } from "./image";
import type { OcrWord } from "../src/core/types";
const word = (text: string, x: number, y = 5, confidence = 95): OcrWord => ({ text, x, y, width: text.length * 7, height: 12, confidence, block: 1, paragraph: 1, line: y });

describe("measured panel features", () => {
  it("distinguishes constant character advances from proportional advances", () => {
    const measured = (steps: number[]) => {
      let x = 0;
      return [ { ...word("measurement", 0), symbols: steps.map((step) => { x += step; return { text: "a", x, y: 0, width: 4, height: 12 }; }) } ];
    };
    expect(measureFont(measured(Array(20).fill(7)), UI_FONT).family).toBe(MONO_FONT);
    expect(measureFont(measured(Array.from({ length: 20 }, (_, i) => i % 2 ? 3 : 11)), MONO_FONT).family).toBe(UI_FONT);
    expect(measureFont([], UI_FONT).evidence).toBe("insufficient");
  });
  it("keeps a multiword control together and splits on gaps or backgrounds", () => {
    const pixels = new FakeImage(300, 40, [25, 25, 25]);
    pixels.fill(75, 0, 160, 39, [55, 55, 55]);
    const words = [word("Open", 4), word("File", 37), word("Save", 80), word("Help", 220)];
    expect(splitItems(words, pixels).map((item) => item.map((w) => w.text))).toEqual([["Open", "File"], ["Save"], ["Help"]]);
  });
  it("only drops icon-like low-confidence text in chrome; preserves labels and filenames", () => {
    const component = { id: "side", type: "sidebar" as const, parent: null, box: { x: 0, y: 0, width: 295, height: 367 } };
    expect(chromeNoise(word("aoe", 260, 5, 50), component)).toBe(true);
    expect(chromeNoise(word("@efca", 240, 35, 0), component)).toBe(true);
    for (const text of ["src", "npm", "New", "aaa.ts", "123", "user@example.com"]) expect(chromeNoise(word(text, 250, 5, 10), component)).toBe(false);
    expect(chromeNoise(word("aoe", 260, 120, 10), component)).toBe(false);
    expect(chromeNoise(word("aoe", 260, 5, 90), component)).toBe(false);
    expect(chromeNoise(word("aoe", 260, 5, 10), { ...component, type: "code" })).toBe(false);
  });
  it("cleans detected code, renumbers the gutter and retains Debug and cropped text", () => {
    const raw = [
      '7 t', '2   \u201cname\u201d: \u201cweb\u201d,', '3   \u201cversion\u201d: \u201c2.0\u201d,',
      '4   \u201cprivate\u201d: true,', '5   \u201cdescription\u201d: \u201cwith TypeScript and Nod',
      '6   \u201ctype\u201d: \u201cmodule\u201d,', 'Debug', '7   \u201cscripts\u201d: {',
      '8     \u201cdev\u201d: \u201crun the cropped comm', '9     \u201cbuild\u201d: \u201cbuild\u201d,',
      '16    \u201cstart\u201d: \u201cnode\u201d,', '11    \u201ctest\u201d: "\u201cvitest run\u201d,',
      '12    \u201ceval\u201d: \u201ceval\u201d,', '13 b',
    ];
    const pixels = new FakeImage(1033, 367, [24, 24, 24]);
    const result = convert({ fileName: "ide.png", pixels, words: [word("Explorer", 5), ...raw.map((text, i) => word(text, 310, 50 + i * 19))], animated: false, kind: "terminal", layout: validateLayout(fixture, 1033, 367) });
    const text = result.html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"');
    expect(result.review.code?.language).toBe("json");
    expect(result.review.code?.line_numbers_removed).toBe(true);
    expect(result.review.code?.braces_repaired).toBe(2);
    expect(result.review.code?.quotes_straightened).toBeGreaterThan(0);
    expect(text).toContain("Debug");
    expect(text).toContain('"test": "vitest run",');
    expect(text).toContain("and Nod");
    expect(text).not.toContain("Node server");
    expect(text).toContain("cropped comm");
    expect(text).not.toContain("...");
    expect(result.model.regions.flatMap((r) => r.lines.flatMap((l) => l.spans)).some((s) => s.text.includes("cropped"))).toBe(true);
    expect(checkCanvasSafe(result.html)).toEqual([]);
    expect(result.html).toContain('id="layout-editor" style="min-width:0;overflow:hidden;background-color:#181818;');
  });
});

describe("tree arrows", () => {
  const sidebar = validateLayout(fixture, 1033, 367)!.components.find((c) => c.type === "sidebar")!;
  // As OCR read the VS Code Explorer: closed folders ">", open ones "v" or "Y".
  const tree = [word("v", 5, 40), word("ImgHtml", 20, 40), word(">", 12, 60), word(".venv", 26, 60), word(">", 12, 80), word("docs", 26, 80),
    word(">", 12, 100), word("out", 26, 100), word("Y", 12, 120), word("web", 26, 120)];

  it("draws a sidebar's arrow glyphs as › and ⌄", () => {
    const arrows = treeArrows(tree, sidebar);
    expect([...arrows.values()]).toEqual(["⌄", "›", "›", "›", "⌄"]);
    expect([...arrows.keys()].map((w) => w.text)).toEqual(["v", ">", ">", ">", "Y"]);
  });
  it("leaves letters alone without a column of closed arrows, or outside a sidebar", () => {
    expect(treeArrows([word("v", 5, 40), word("ImgHtml", 20, 40), word("Y", 12, 120), word("web", 26, 120)], sidebar).size).toBe(0);
    expect(treeArrows(tree, { ...sidebar, type: "content" }).size).toBe(0);
    const lone = word("v", 12, 140); // no label after it: not an arrow
    expect(treeArrows([...tree, lone], sidebar).has(lone)).toBe(false);
  });
});
