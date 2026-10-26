import { describe, expect, it } from "vitest";
import {
  BLACK,
  WHITE,
  colorsFromWords,
  contrast,
  fixContrast,
  hlsToRgb,
  localBackground,
  rgbHex,
  rgbToHls,
  textColor,
} from "../src/core/colors";
import type { Box, RGB } from "../src/core/types";
import { FakeImage } from "./image";

/** A small fake screenshot: a block of "text" and an optional colored
 *  ring (like a red highlight circle) outside the text box. */
function screenshot(background: RGB, text: RGB, decoration?: RGB): [FakeImage, Box[]] {
  const image = new FakeImage(200, 60, background);
  image.fill(20, 20, 99, 39, text);
  const edge = text.map((t, i) => Math.floor((t + background[i]!) / 2)) as unknown as RGB;
  image.outline(19, 19, 100, 40, edge);
  if (decoration) image.ring(110, 2, 196, 58, 6, decoration);
  return [image, [{ x: 19, y: 19, width: 82, height: 22 }]];
}

const gray = (v: number): RGB => [v, v, v];

describe("measured colors", () => {
  it("dark terminal: exact text color", () => {
    const [image, boxes] = screenshot(gray(0x18), gray(0xcc));
    const { background, foreground } = colorsFromWords(image, boxes);
    expect(rgbHex(background)).toBe("#181818");
    expect(rgbHex(foreground)).toBe("#cccccc");
  });

  it("red circle outside the words is ignored", () => {
    const [image, boxes] = screenshot(WHITE, [0x00, 0x80, 0x00], [0xe0, 0x00, 0x00]);
    expect(rgbHex(colorsFromWords(image, boxes).foreground)).toBe("#008000");
  });

  it("no rounding of the text color", () => {
    const [image, boxes] = screenshot(gray(0x1e), gray(0xd4));
    expect(rgbHex(colorsFromWords(image, boxes).foreground)).toBe("#d4d4d4");
  });

  it("no words: falls back, still finds the background", () => {
    const [image] = screenshot(gray(0x18), gray(0xcc));
    expect(rgbHex(colorsFromWords(image, []).background)).toBe("#181818");
  });

  it("one text color: no second color", () => {
    const [image, boxes] = screenshot(gray(0x18), gray(0xcc));
    expect(colorsFromWords(image, boxes).secondaryRatio).toBeLessThan(0.3);
  });

  it("mixed text colors detected", () => {
    const image = new FakeImage(200, 40, WHITE);
    const colors: RGB[] = [[0xaf, 0x00, 0xdb], [0x00, 0x80, 0x00], [0xa3, 0x15, 0x15], [0x00, 0x00, 0xff]];
    colors.forEach((c, i) => image.fill(10 + 45 * i, 10, 50 + 45 * i, 29, c));
    const { secondaryRatio } = colorsFromWords(image, [{ x: 10, y: 10, width: 180, height: 20 }]);
    expect(secondaryRatio).toBeGreaterThanOrEqual(0.3);
  });
});

describe("colors inside one box", () => {
  it("text color skips blended edge pixels", () => {
    const [image, boxes] = screenshot(gray(0x18), [0xdc, 0xdc, 0xaa]);
    expect(textColor(image, boxes[0]!, gray(0x18))).toEqual([0xdc, 0xdc, 0xaa]);
  });

  it("nothing stands out: no text color", () => {
    const image = new FakeImage(20, 20, gray(0x18));
    expect(textColor(image, { x: 0, y: 0, width: 20, height: 20 }, gray(0x18))).toBeUndefined();
  });

  it("local background is the color around a word", () => {
    const image = new FakeImage(100, 40, gray(0x18));
    image.fill(10, 5, 60, 30, [0x2a, 0x2d, 0x2e]); // a highlighted row
    image.fill(20, 12, 40, 22, gray(0xcc)); // its text
    expect(localBackground(image, { x: 20, y: 12, width: 21, height: 11 })).toEqual([0x2a, 0x2d, 0x2e]);
  });
});

describe("contrast", () => {
  it("black on white is 21:1", () => {
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 5);
  });

  it("passing colors are left alone", () => {
    expect(fixContrast(gray(0xcc), BLACK)).toEqual(gray(0xcc));
  });

  it("low contrast: only lightness changes, to the nearest passing value", () => {
    const fixed = fixContrast([0x33, 0x66, 0x99], BLACK);
    expect(contrast(fixed, BLACK)).toBeGreaterThanOrEqual(4.5);
    const [h0, , s0] = rgbToHls(0x33 / 255, 0x66 / 255, 0x99 / 255);
    const [h1, , s1] = rgbToHls(fixed[0] / 255, fixed[1] / 255, fixed[2] / 255);
    expect(h1).toBeCloseTo(h0, 2);
    expect(s1).toBeCloseTo(s0, 1);
  });

  it("HLS round trip matches Python's colorsys", () => {
    // colorsys.rgb_to_hls(0.2, 0.4, 0.6) == (0.5833333333333334, 0.4, 0.5)
    const [h, l, s] = rgbToHls(0.2, 0.4, 0.6);
    expect(h).toBeCloseTo(0.5833333333333334, 12);
    expect(l).toBeCloseTo(0.4, 12);
    expect(s).toBeCloseTo(0.5, 12);
    const [r, g, b] = hlsToRgb(h, l, s);
    expect([r, g, b].map((v) => v.toFixed(9))).toEqual(["0.200000000", "0.400000000", "0.600000000"]);
  });
});
