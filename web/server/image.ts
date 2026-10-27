import sharp, { type Sharp } from "sharp";
import { decode as decodeBmp } from "bmp-ts";
import type { Pixels } from "../src/core/types";
import { SUPPORTED } from "../src/shared/api";

// Bound decoded memory as well as the compressed upload size.
export const MAX_PIXELS = 40_000_000;
const formats: Record<string, string> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif",
  ".webp": "webp", ".bmp": "bmp", ".tif": "tiff", ".tiff": "tiff",
};

export class InvalidImage extends Error {
  statusCode = 400;
}

export interface DecodedImage {
  pixels: Pixels;
  animated: boolean;
  png: Buffer;
}

/** Trust decoded contents, not the browser's MIME type or just a suffix. */
export async function decodeImage(bytes: Buffer, fileName: string): Promise<DecodedImage> {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!(SUPPORTED as readonly string[]).includes(ext)) {
    throw new InvalidImage("Unsupported image format. Use PNG, JPG, GIF, WEBP, BMP, or TIFF.");
  }
  try {
    let image: Sharp;
    let animated = false;
    if (ext === ".bmp") {
      // sharp's prebuilt libvips has no BMP loader. Check dimensions before
      // bmp-ts allocates its pixel buffer (Windows DIB headers, including V5).
      if (bytes.length < 54 || bytes.toString("ascii", 0, 2) !== "BM" || bytes.readUInt32LE(14) < 40) {
        throw new Error("Invalid BMP header");
      }
      const width = bytes.readInt32LE(18);
      const height = Math.abs(bytes.readInt32LE(22));
      if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw new Error("Invalid BMP dimensions");
      const decoded = decodeBmp(bytes, { toRGBA: true });
      // Palette/24-bit and BI_RGB BMPs reserve this byte; it is not alpha.
      const headerSize = bytes.readUInt32LE(14);
      const compression = bytes.readUInt32LE(30);
      const alphaMask = (headerSize >= 56 || compression === 6) && bytes.length >= 70 ? bytes.readUInt32LE(66) : 0;
      if (!alphaMask) {
        for (let i = 3; i < decoded.data.length; i += 4) decoded.data[i] = 255;
      }
      image = sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
    } else {
      const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
      if (metadata.format !== formats[ext]) throw new Error("File extension does not match image contents");
      // libvips composites GIF disposal/partial frames before selecting a page.
      const pages = metadata.pages ?? 1;
      animated = ext === ".gif" && pages > 1;
      image = sharp(bytes, { page: animated ? pages - 1 : 0, pages: 1, limitInputPixels: MAX_PIXELS });
    }
    const { data, info } = await image.autoOrient().flatten({ background: "#ffffff" })
      .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    return { pixels, animated, png };
  } catch (error) {
    throw new InvalidImage(`Cannot decode image: ${error instanceof Error ? error.message : String(error)}`);
  }
}
