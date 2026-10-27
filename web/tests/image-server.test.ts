import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { encode } from "bmp-ts";
import { decodeImage, MAX_PIXELS } from "../server/image";

describe("server image decoding", () => {
  it.each(["png", "jpeg", "webp", "tiff"] as const)("decodes %s into RGBA and a portable PNG", async (format) => {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#123456" } }).toFormat(format).toBuffer();
    const result = await decodeImage(bytes, `test.${format}`);
    expect(result.pixels.width).toBe(12);
    expect(result.pixels.height).toBe(8);
    expect(result.pixels.data.length).toBe(12 * 8 * 4);
    expect(result.animated).toBe(false);
    expect((await sharp(result.png).metadata()).format).toBe("png");
  });

  it("composites GIF frames and reads the last frame", async () => {
    const frames = Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 255,
      255, 0, 0, 255, 0, 0, 255, 255,
      255, 0, 0, 255, 255, 0, 0, 255,
    ]);
    const gif = await sharp(frames, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).gif({ delay: [100, 100] }).toBuffer();
    const result = await decodeImage(gif, "animation.GIF");
    expect(result.animated).toBe(true);
    expect([result.pixels.width, result.pixels.height]).toEqual([2, 2]);
    expect([...result.pixels.data]).toEqual([...frames.subarray(16)]);
  });

  it("flattens transparency on white and applies EXIF orientation", async () => {
    const png = await sharp({ create: { width: 12, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect([...(await decodeImage(png, "a.png")).pixels.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    const jpeg = await sharp(png).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const rotated = await decodeImage(jpeg, "a.jpg");
    expect([rotated.pixels.width, rotated.pixels.height]).toEqual([8, 12]);
  });

  it("keeps BMP support without depending on a system libvips loader", async () => {
    const bmp = encode({ width: 2, height: 1, data: Buffer.from([0, 0x56, 0x34, 0x12, 0, 0x56, 0x34, 0x12]) }).data;
    const result = await decodeImage(bmp, "a.bmp");
    expect([...result.pixels.data]).toEqual([0x12, 0x34, 0x56, 255, 0x12, 0x34, 0x56, 255]);
    const huge = Buffer.from(bmp);
    huge.writeInt32LE(MAX_PIXELS + 1, 18);
    await expect(decodeImage(huge, "a.bmp")).rejects.toThrow("dimensions");
  });

  it("rejects corrupt files, spoofed extensions and unsupported formats", async () => {
    await expect(decodeImage(Buffer.from("not a PNG"), "a.png")).rejects.toThrow("Cannot decode");
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    await expect(decodeImage(png, "a.tiff")).rejects.toThrow("does not match");
    await expect(decodeImage(png, "a.svg")).rejects.toThrow("Unsupported");
  });
});
