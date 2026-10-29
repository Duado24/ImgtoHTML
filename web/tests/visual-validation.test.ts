import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateResponsive, validateVisual } from "../server/visual-validation";
import { convert } from "../src/core/convert";
import { renderEditorWindow } from "../src/core/editor-window";
import { plainLines } from "../src/core/paint";
import { renderLayoutPanel } from "../src/core/render";
import { renderLayout, validateLayout } from "../src/core/vision-layout";
import { KINDS, type OcrWord } from "../src/core/types";
import { FakeImage } from "./image";
import fixture from "./fixtures/vscode-package-json.layout.json";

const longLine = 'const description = "' + "Screenshot text must remain readable on a phone. ".repeat(8) + '";';
const token = "long_identifier_".repeat(24);
const lines = plainLines([longLine, token]);
const editorHtml = () => renderEditorWindow(lines, {
  sidebar: ["Explorer", "v course", "  > lessons", "  > examples"],
  header: ["README.md     package.json X     notes.md", "course > package.json"], hints: [], firstLine: 1,
}, "#d4d4d4", "Editor", null);

const expectFits = (reports: Awaited<ReturnType<typeof validateResponsive>>) => {
  expect(reports.map((r) => r.width)).toEqual([375, 768, 1280]);
  for (const report of reports) {
    expect(report.horizontalOverflow, `horizontal overflow at ${report.width}px`).toBe(0);
    expect(report.clippedText, `clipped text at ${report.width}px`).toEqual([]);
  }
};

describe("Chromium responsive HTML validation", () => {
  it.each(KINDS)("keeps %s screenshot text visible at phone, tablet and desktop widths", async (kind) => {
    const pixels = new FakeImage(1280, 100, [30, 30, 30]);
    const words: OcrWord[] = [longLine, token].map((text, i) => ({
      text, x: 10, y: 10 + i * 30, width: 1200, height: 14, confidence: 98, block: 0, paragraph: 0, line: i,
    }));
    const { html } = convert({ fileName: `${kind}.png`, pixels, words, animated: false, kind });
    expectFits(await validateResponsive(html));
  }, 30_000);

  it("checks the editor window at 375px through the existing visual validator", async () => {
    const original = await sharp({ create: { width: 1280, height: 400, channels: 3, background: "#1f1f1f" } }).png().toBuffer();
    const report = await validateVisual(editorHtml(), original, { application: "ide", components: [] }, 1280, 400);
    expectFits(report.responsive);
    expect(report.discrepancies).toEqual([]);
  }, 30_000);

  it("wraps code inside a detected sidebar/editor layout", async () => {
    const layout = validateLayout(fixture, 1033, 367)!;
    const words: OcrWord[] = [{ text: longLine + token, x: 310, y: 80, width: 700, height: 14, confidence: 99, block: 0, paragraph: 0, line: 0 }];
    const html = renderLayout(layout, words, 1033, "Editor", null, () => renderLayoutPanel({
      lines, fontSize: 13, padding: { top: 0, right: 0, bottom: 0, left: 0 },
    }, [30, 30, 30], [212, 212, 212]));
    expectFits(await validateResponsive(html));
  }, 30_000);

  it("detects clipped glyphs even when overflow:hidden prevents page scrolling", async () => {
    const [report] = await validateResponsive(`<div style="width:150px;overflow:hidden;white-space:pre;">${token}</div>`, [375]);
    expect(report!.horizontalOverflow).toBe(0);
    expect(report!.clippedText).toEqual([token.slice(0, 160)]);
  }, 30_000);

  it("detects a page that scrolls sideways", async () => {
    const [report] = await validateResponsive('<div style="width:900px;">Wide content</div>', [375]);
    expect(report!.horizontalOverflow).toBeGreaterThan(0);
  }, 30_000);

  it("detects text hidden below a fixed-height panel", async () => {
    const [report] = await validateResponsive('<div style="height:10px;line-height:24px;overflow:hidden;">Clipped below</div>', [375]);
    expect(report!.horizontalOverflow).toBe(0);
    expect(report!.clippedText).toEqual(["Clipped below"]);
  }, 30_000);
});
