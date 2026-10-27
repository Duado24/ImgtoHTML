/** Optional integration check: needs native Tesseract + installed local WASM data. */
import assert from "node:assert/strict";
import sharp from "sharp";
import { NativeTesseract } from "../server/ocr/native";
import { LocalOcr } from "../server/ocr";
import { TesseractJs } from "../server/ocr/tesseract-js";

const png = await sharp(Buffer.from('<svg width="700" height="100"><rect width="700" height="100" fill="white"/><text x="20" y="65" font-family="sans-serif" font-size="40" fill="black">Hello local OCR 123</text></svg>')).png().toBuffer();
const image = { png, width: 700, height: 100 };
for (const [name, engine] of [
  ["native", new NativeTesseract()],
  ["fallback", new LocalOcr(new NativeTesseract("imgtohtml-intentionally-missing-tesseract"), new TesseractJs())],
] as const) {
  try {
    const words = await engine.recognize(image);
    const text = words.map((w) => w.text).join(" ");
    assert.match(text, /Hello local OCR 123/);
    assert.ok(words.every((w) => w.width > 0 && w.height > 0 && w.confidence >= 0));
    assert.ok(words.every((w) => (w.symbols?.length ?? 0) > 0));
    console.log(`${name}: ${text} (word and character boxes verified)`);
  } finally {
    if ("close" in engine) await engine.close();
  }
}
