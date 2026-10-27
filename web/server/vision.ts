import sharp from "sharp";
import { cropPixels } from "../src/core/preprocess";
import type { Box, Pixels } from "../src/core/types";
import type { RegionReading } from "../src/core/vision";

export interface VisionRegion {
  id: string;
  box: Box;
}

/** Reads regions of a screenshot. Its text never replaces OCR text; see
 *  src/core/vision.ts for how readings are merged. */
export interface VisionModel {
  /** Short name shown in the review, e.g. "qwen3-vl:8b-instruct-q4_K_M". */
  readonly name: string;
  analyze(image: Pixels, regions: readonly VisionRegion[]): Promise<RegionReading[]>;
}

export class NullVisionModel implements VisionModel {
  readonly name = "none";
  async analyze(_image: Pixels, _regions: readonly VisionRegion[]): Promise<RegionReading[]> {
    return [];
  }
}

export const ROLES = ["terminal", "code", "sidebar", "tabs", "menu", "toolbar", "dialog", "diagram", "text", "other"] as const;

const PROMPT =
  "This is one region of a screenshot from a computer science course. " +
  "Transcribe every character of text in it exactly as shown: same line breaks, same spelling, " +
  "same punctuation, straight or curly quotes as they appear. Do not fix, translate or explain anything. " +
  `Also say what the region is: one of ${ROLES.join(", ")}.`;

const SCHEMA = {
  type: "object",
  properties: { role: { type: "string", enum: [...ROLES] }, text: { type: "string" } },
  required: ["role", "text"],
};

/** Regions smaller than this (px) are skipped; larger ones are shrunk to fit. */
const MIN_SIDE = 12;
const MAX_SIDE = 1600;
const MAX_REGIONS = 12;

/** A vision model served by Ollama on this computer. */
export class OllamaVisionModel implements VisionModel {
  constructor(
    readonly name = process.env.OLLAMA_MODEL ?? "qwen3-vl:8b-instruct-q4_K_M",
    private readonly url = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    private readonly timeoutMs = 120_000,
  ) {}

  private async png(image: Pixels, box: Box): Promise<string> {
    const crop = cropPixels(image, box);
    let pipeline = sharp(Buffer.from(crop.data.buffer, crop.data.byteOffset, crop.data.byteLength), {
      raw: { width: crop.width, height: crop.height, channels: 4 },
    });
    if (Math.max(crop.width, crop.height) > MAX_SIDE) pipeline = pipeline.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside" });
    return (await pipeline.png().toBuffer()).toString("base64");
  }

  private async read(image: string): Promise<{ role: string; text: string }> {
    const response = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.name,
        stream: false,
        format: SCHEMA,
        options: { temperature: 0 },
        messages: [{ role: "user", content: PROMPT, images: [image] }],
      }),
    });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(body.message?.content ?? "{}") as { role?: unknown; text?: unknown };
    return {
      role: (ROLES as readonly unknown[]).includes(parsed.role) ? String(parsed.role) : "other",
      text: typeof parsed.text === "string" ? parsed.text : "",
    };
  }

  async analyze(image: Pixels, regions: readonly VisionRegion[]): Promise<RegionReading[]> {
    const readings: RegionReading[] = [];
    for (const region of regions.filter((r) => Math.min(r.box.width, r.box.height) >= MIN_SIDE).slice(0, MAX_REGIONS)) {
      readings.push({ regionId: region.id, ...(await this.read(await this.png(image, region.box))) });
    }
    return readings;
  }

  /** True when Ollama answers and has the model. */
  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const { models = [] } = (await response.json()) as { models?: { name: string }[] };
      return models.some((m) => m.name === this.name || m.name === `${this.name}:latest`);
    } catch {
      return false;
    }
  }
}
