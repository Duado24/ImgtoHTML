import sharp from "sharp";
import { cropPixels } from "../src/core/preprocess";
import type { Box, Pixels } from "../src/core/types";
import type { Diagram } from "../src/core/diagram";
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
  /** `focus`: one region the reviewer asked to re-read closely, with an optional hint. */
  analyze(image: Pixels, regions: readonly VisionRegion[], focus?: { hint?: string }): Promise<RegionReading[]>;
  /** Diagrams only: parts and connections, for a text description. */
  describeDiagram?(image: Pixels): Promise<Diagram>;
}

export class NullVisionModel implements VisionModel {
  readonly name = "none";
  async analyze(_image: Pixels, _regions: readonly VisionRegion[], _focus?: { hint?: string }): Promise<RegionReading[]> {
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

const DIAGRAM_PROMPT =
  "This is a diagram (flowchart, framework or architecture map) from a computer science course. " +
  "List every box or shape as a part with its exact label text and a shape kind " +
  "(start, end, process, decision, data, note, group), and every arrow or line as a connection " +
  "from one part to another, with any text written on the arrow. Follow the arrows' direction. " +
  "Then write a one or two sentence summary of what the diagram shows, for a student who cannot see it. " +
  "Use only what is in the image.";

const DIAGRAM_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    nodes: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, shape: { type: "string" } }, required: ["id", "label", "shape"] },
    },
    edges: {
      type: "array",
      items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to", "label"] },
    },
  },
  required: ["summary", "nodes", "edges"],
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

  /** `enlarge`: scale small crops up so small text gets more of the model's attention. */
  private async png(image: Pixels, box: Box, enlarge: boolean): Promise<string> {
    const crop = cropPixels(image, box);
    let pipeline = sharp(Buffer.from(crop.data.buffer, crop.data.byteOffset, crop.data.byteLength), {
      raw: { width: crop.width, height: crop.height, channels: 4 },
    });
    const side = Math.max(crop.width, crop.height);
    const target = enlarge ? Math.min(MAX_SIDE, side * 2) : Math.min(MAX_SIDE, side);
    if (target !== side) pipeline = pipeline.resize({ width: target, height: target, fit: "inside", kernel: "lanczos3" });
    return (await pipeline.png().toBuffer()).toString("base64");
  }

  /** One chat request with an image, answered as JSON matching `format`. */
  private async ask(content: string, image: string, format: object): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.name,
        stream: false,
        format,
        options: { temperature: 0 },
        messages: [{ role: "user", content, images: [image] }],
      }),
    });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { message?: { content?: string } };
    return JSON.parse(body.message?.content ?? "{}") as Record<string, unknown>;
  }

  async describeDiagram(image: Pixels): Promise<Diagram> {
    const box = { x: 0, y: 0, width: image.width, height: image.height };
    const parsed = (await this.ask(DIAGRAM_PROMPT, await this.png(image, box, false), DIAGRAM_SCHEMA)) as Partial<Diagram>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((n) => ({ id: str(n.id), label: str(n.label), shape: str(n.shape) }));
    const ids = new Set(nodes.map((n) => n.id));
    return {
      summary: str(parsed.summary),
      nodes: nodes.filter((n) => n.id && n.label),
      // Drop arrows to parts that weren't listed.
      edges: (Array.isArray(parsed.edges) ? parsed.edges : [])
        .map((e) => ({ from: str(e.from), to: str(e.to), label: str(e.label) }))
        .filter((e) => ids.has(e.from) && ids.has(e.to)),
    };
  }

  private async read(image: string, hint?: string): Promise<{ role: string; text: string }> {
    const content = hint ? `${PROMPT}\nThe reviewer says this reading was wrong before. Their hint: ${hint}` : PROMPT;
    const parsed = await this.ask(content, image, SCHEMA);
    return {
      role: (ROLES as readonly unknown[]).includes(parsed.role) ? String(parsed.role) : "other",
      text: typeof parsed.text === "string" ? parsed.text : "",
    };
  }

  async analyze(image: Pixels, regions: readonly VisionRegion[], focus?: { hint?: string }): Promise<RegionReading[]> {
    const readings: RegionReading[] = [];
    for (const region of regions.filter((r) => Math.min(r.box.width, r.box.height) >= MIN_SIDE).slice(0, MAX_REGIONS)) {
      const png = await this.png(image, region.box, focus !== undefined);
      readings.push({ regionId: region.id, ...(await this.read(png, focus?.hint?.trim() || undefined)) });
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
