import type { OcrEngine, OcrImage } from "./engine";
import { NativeTesseract } from "./native";
import { TesseractJs } from "./tesseract-js";

export class LocalOcr implements OcrEngine {
  private useFallback = false;
  constructor(private readonly native: OcrEngine = new NativeTesseract(), private readonly fallback: OcrEngine = new TesseractJs()) {}

  async recognize(image: OcrImage) {
    if (!this.useFallback) {
      try { return await this.native.recognize(image); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.useFallback = true;
      }
    }
    return this.fallback.recognize(image);
  }

  async close(): Promise<void> {
    await this.native.close?.();
    await this.fallback.close?.();
  }
}
