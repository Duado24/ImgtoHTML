import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { LocalOcr } from "../server/ocr";
import { parseTsv, withSymbols } from "../server/ocr/native";
import { recognizeWords } from "../server/ocr/pipeline";
import { NullVisionModel } from "../server/vision";
import { FakeImage } from "./image";
import type { OcrWord } from "../src/core/types";
import type { OcrImage } from "../server/ocr/engine";

const word = (text: string, x: number, confidence = 95): OcrWord => ({ text, x, y: 10, width: 30, height: 12, confidence, block: 0, paragraph: 0, line: 0 });
const scaled = (w: OcrWord): OcrWord => ({ ...w, x: (w.x + 8) * 3, y: (w.y + 8) * 3, width: w.width * 3, height: w.height * 3 });

describe("OCR engines", () => {
  it("reads TSV word confidence/ids and joins top-left character boxes", () => {
    const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n" +
      "4\t1\t2\t3\t4\t0\t10\t20\t30\t10\t-1\t\n" +
      "5\t1\t2\t3\t4\t1\t10\t20\t30\t10\t62.5\thi\n";
    const words = parseTsv(tsv);
    expect(words).toEqual([{ text: "hi", block: 2, paragraph: 3, line: 4, x: 10, y: 20, width: 30, height: 10, confidence: 62.5 }]);
    expect(withSymbols(words, "h 10 70 20 80 0\ni 21 70 30 80 0\nz 90 0 100 10 0\n", 100)[0]!.symbols).toEqual([
      { text: "h", x: 10, y: 20, width: 10, height: 10 }, { text: "i", x: 21, y: 20, width: 9, height: 10 },
    ]);
  });

  it("falls back only for a missing CLI, remembers selection and closes both engines", async () => {
    const native = { recognize: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })), close: vi.fn() };
    const fallback = { recognize: vi.fn().mockResolvedValue([word("fallback", 10)]), close: vi.fn() };
    const engine = new LocalOcr(native, fallback);
    const image = { png: Buffer.alloc(0), width: 1, height: 1 };
    expect(await engine.recognize(image)).toEqual([word("fallback", 10)]);
    await engine.recognize(image);
    expect(native.recognize).toHaveBeenCalledTimes(1);
    expect(fallback.recognize).toHaveBeenCalledTimes(2);
    await engine.close();
    expect(native.close).toHaveBeenCalledOnce();
    expect(fallback.close).toHaveBeenCalledOnce();
    native.recognize.mockRejectedValue(new Error("language missing"));
    await expect(new LocalOcr(native, fallback).recognize(image)).rejects.toThrow("language missing");
    expect(fallback.recognize).toHaveBeenCalledTimes(2);
  });

  it("passes enlarged ink and white padding through the interface, restores coordinates", async () => {
    const pixels = new FakeImage(100, 50, [24, 24, 24]);
    pixels.fill(10, 10, 39, 21, [220, 220, 220]);
    const recognize = vi.fn(async (image: OcrImage) => {
      expect([image.width, image.height]).toEqual([348, 198]);
      const data = await sharp(image.png).ensureAlpha().raw().toBuffer();
      const pixel = (x: number, y: number) => [...data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
      expect(pixel(0, 0)).toEqual([255, 255, 255, 255]);
      expect(pixel(60, 60)).toEqual([0, 0, 0, 255]);
      return [{ ...scaled(word("hello", 10)), symbols: [{ text: "h", x: 54, y: 54, width: 15, height: 36 }] }];
    });
    const words = await recognizeWords({ recognize }, pixels);
    expect(words[0]).toMatchObject(word("hello", 10));
    expect(words[0]!.symbols).toEqual([{ text: "h", x: 10, y: 10, width: 5, height: 12 }]);
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("rereads panels with their own background and keeps the better reading in each", async () => {
    const pixels = new FakeImage(400, 120, [24, 24, 24]);
    pixels.fill(120, 0, 120, 119, [43, 43, 43]);
    pixels.fill(121, 0, 399, 119, [31, 31, 31]);
    const first = [word("bad", 10, 40), word("correct", 140)];
    const recognize = vi.fn().mockResolvedValueOnce(first.map(scaled))
      .mockResolvedValueOnce([scaled(word("Explorer", 10))])
      .mockResolvedValueOnce([scaled(word("~", 19, 20))]);
    const progress = vi.fn();
    const words = await recognizeWords({ recognize }, pixels, progress);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(words.map((w) => w.text)).toEqual(["Explorer", "correct"]);
    expect(words[0]).toMatchObject({ x: 10, y: 10, block: 1000 });
    expect(words[1]).toMatchObject({ x: 140, y: 10, block: 0 });
    expect(progress).toHaveBeenCalledWith("Reading panel 2 of 2…");
    const panel = recognize.mock.calls[2]![0] as OcrImage;
    const data = await sharp(panel.png).raw().toBuffer();
    expect(data[4 * (40 * panel.width + 40)]).toBe(255);
  });

  it("defines a vision extension point with no model behavior", async () => {
    expect(await new NullVisionModel().analyze(new FakeImage(1, 1, [0, 0, 0]), [])).toEqual([]);
  });
});
