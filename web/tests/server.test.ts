import { NullVisionModel } from "../server/vision";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createApp, HOST } from "../server/app";
import type { OcrEngine } from "../server/ocr/engine";
import type { Job, JobResult } from "../src/shared/api";
import { MAX_UPLOAD_BYTES } from "../src/shared/api";
import type { OcrWord } from "../src/core/types";
import { FakeImage } from "./image";

type App = Awaited<ReturnType<typeof createApp>>;
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });

const words: OcrWord[] = [
  { text: "/home/alice/app", x: 10, y: 10, width: 140, height: 14, confidence: 96, block: 0, paragraph: 0, line: 0 },
  { text: "alice@example.edu", x: 10, y: 40, width: 160, height: 14, confidence: 52, block: 0, paragraph: 0, line: 1 },
];
const scaledWords = words.map((w) => ({ ...w, x: (w.x + 8) * 3, y: (w.y + 8) * 3, width: w.width * 3, height: w.height * 3 }));

async function setup(engine: OcrEngine = { recognize: vi.fn().mockResolvedValue(scaledWords) }) {
  const app = await createApp({ ocr: engine, vision: new NullVisionModel(), clientRoot: false });
  apps.push(app);
  const pixels = new FakeImage(300, 80, [30, 30, 30]);
  for (const w of words) pixels.fill(w.x, w.y, w.x + w.width - 1, w.y + w.height - 1, [212, 212, 212]);
  const png = await sharp(Buffer.from(pixels.data), { raw: { width: pixels.width, height: pixels.height, channels: 4 } }).png().toBuffer();
  return { app, engine, png };
}

function multipart(image?: Buffer, fields: Record<string, string> = {}, filename = "Screen shot.PNG", fileField = "image") {
  const boundary = "test-image-boundary";
  const chunks: Buffer[] = [];
  if (image) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), image, Buffer.from("\r\n"));
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { method: "POST" as const, url: "/api/convert", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

async function submit(app: App, png: Buffer, fields: Record<string, string> = {}, filename?: string) {
  const response = await app.inject(multipart(png, fields, filename));
  expect(response.statusCode, response.body).toBe(202);
  const { id } = response.json<{ id: string }>();
  expect(response.headers.location).toBe(`/api/jobs/${id}`);
  return id;
}

async function finished(app: App, id: string): Promise<Job> {
  let job: Job;
  await expect.poll(async () => {
    const response = await app.inject(`/api/jobs/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    job = response.json<Job>();
    return job.status === "completed" || job.status === "failed";
  }).toBe(true);
  return job!;
}

async function result(app: App, id: string): Promise<JobResult> {
  const job = await finished(app, id);
  if (job.status !== "completed") throw new Error(JSON.stringify(job));
  return job.result;
}

describe("local conversion API / Python parity", () => {
  it("returns a job id, masks identities, preserves review fields and all four file names", async () => {
    const { app, png } = await setup();
    const output = await result(app, await submit(app, png, { kind: "terminal", label: "  ", caption: "  " }));
    expect(output.transcript).toContain("/home/username/app");
    expect(output.transcript).toContain("username@example.edu");
    expect(JSON.stringify(output.review)).not.toContain("alice");
    expect(output.html).not.toContain("alice");
    expect(output.html).toContain('aria-label="Terminal screenshot showing the content of Screen shot"');
    expect(output.review).toMatchObject({
      type: "terminal", low_confidence_words: [{ text: "username@example.edu", confidence: 52 }],
      original_colors: { background: "#1e1e1e", foreground: "#d4d4d4" },
      contrast_changes: [], second_color_ratio: expect.any(Number), check_colors_by_hand: false, contrast_ratio: expect.any(Number),
      privacy: { home_path_masking: true, learned_email_identity_masking: true, generic_email_replacement: false, manual_review_required: true },
      limitations: expect.arrayContaining(["OCR requires character-by-character review", "Username masking is pattern-based and incomplete"]),
    });
    expect(output.lowConfidenceCount).toBe(1);
    expect(JSON.parse(output.reviewFile.content)).toEqual(output.review);
    expect(output.htmlFile).toEqual({ name: "Media_Screen_shot.png.html", mime: "text/html", content: output.html });
    expect(output.transcriptFile).toEqual({ name: "Screen_shot_transcript.txt", mime: "text/plain", content: output.transcript });
    expect(output.reviewFile.name).toBe("Screen_shot_review.json");
    expect(output.preview.name).toBe("Screen_shot_preview.html");
    expect(output.preview.content).toContain(output.html);
    expect(output.preview.content).toContain(`src="${output.imageDataUrl}"`);
    expect(output.preview.content).toContain("Screenshot versus HTML draft");
    expect(output.html).not.toMatch(/<(style|script|pre)\b/i);
    expect(output.html).not.toMatch(/\b(class|src)=/);
    expect(output.html.match(/<div style="white-space:/g)).toHaveLength(output.lineCount);
  });

  it("uses corrected text but still runs OCR to measure colors", async () => {
    const { app, png, engine } = await setup();
    const output = await result(app, await submit(app, png, {
      kind: "code", label: "My label", caption: "My caption", transcript: "C:\\Users\\bob\\app\r\nbob@example.org\r\n<hello>",
    }));
    expect(engine.recognize).toHaveBeenCalled();
    expect(output.fromTranscript).toBe(true);
    expect(output.transcript).toBe("C:\\Users\\username\\app\nusername@example.org\n<hello>");
    expect(output.review.original_colors).toEqual({ background: "#1e1e1e", foreground: "#d4d4d4" });
    expect(output.review.low_confidence_words).toEqual([]);
    expect(output.html).toContain("&lt;hello&gt;");
    expect(output.html).toContain('aria-label="My label"');
    expect(output.html).toContain("My caption");
    expect(output.html).not.toContain("alice");
  });

  it("uses a GIF's final frame and default caption, while honoring an explicit caption", async () => {
    const { app } = await setup({ recognize: vi.fn().mockResolvedValue([]) });
    const gif = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
    const output = await result(app, await submit(app, gif, { label: "", caption: "\t " }, "demo.gif"));
    expect(output.html).toContain("Animated in the original. This reconstruction shows the final frame.");
    // The unchanged core quantizes fallback background samples to 5 bits.
    expect(output.review.original_colors.background).toBe("#0000f8");
    const png = Buffer.from(output.imageDataUrl.split(",")[1]!, "base64");
    expect([...await sharp(png).raw().toBuffer()]).toEqual([0, 0, 255, 255]);
    const custom = await result(app, await submit(app, gif, { caption: "Chosen caption" }, "demo.gif"));
    expect(custom.html).toContain("Chosen caption");
    expect(custom.html).not.toContain("Animated in the original");
  });

  it("accepts TIFF and provides a browser-displayable comparison image", async () => {
    const { app, png } = await setup();
    const tiff = await sharp(png).tiff().toBuffer();
    const output = await result(app, await submit(app, tiff, {}, "scan.TIFF"));
    expect(output.htmlFile.name).toBe("Media_scan.tiff.html");
    expect(output.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(output.preview.content).toContain(output.imageDataUrl);
  });

  it("rejects missing, corrupt, unsupported and mislabeled files, invalid kinds and oversized uploads", async () => {
    const { app, png, engine } = await setup();
    for (const request of [
      multipart(undefined, { kind: "code" }), multipart(Buffer.from("bad")), multipart(png, {}, "a.svg"),
      multipart(png, {}, "a.jpg"), multipart(png, { kind: "invalid" }), multipart(png, {}, "a.png", "unexpected"),
      multipart(png, { unknown: "value" }),
    ]) expect((await app.inject(request)).statusCode).toBe(400);
    expect((await app.inject(multipart(Buffer.alloc(MAX_UPLOAD_BYTES + 1)))).statusCode).toBe(413);
    expect((await app.inject(multipart(png, { transcript: "x".repeat(1024 * 1024 + 1) }))).statusCode).toBe(413);
    expect((await app.inject({ method: "POST", url: "/api/convert", payload: {} })).statusCode).toBe(415);
    expect(engine.recognize).not.toHaveBeenCalled();
    // Rejected requests must release their admission slot.
    expect((await app.inject(multipart(png))).statusCode).toBe(202);
  });

  it("reports failed jobs, recovers for the next job and closes the engine", async () => {
    const engine = { recognize: vi.fn().mockRejectedValueOnce(new Error("OCR failed")).mockResolvedValue(scaledWords), close: vi.fn() };
    const { app, png } = await setup(engine);
    const id = await submit(app, png);
    expect(await finished(app, id)).toEqual({ id, status: "failed", error: "OCR failed" });
    expect((await result(app, await submit(app, png))).html).toContain("/home/username/app");
    await app.close();
    expect(engine.close).toHaveBeenCalledOnce();
  });

  it("serializes OCR jobs, reports queued/running status and bounds the queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = { recognize: vi.fn(async () => { await gate; return scaledWords; }) };
    const { app, png } = await setup(engine);
    const first = await submit(app, png);
    try {
      await expect.poll(() => engine.recognize.mock.calls.length).toBe(1);
      expect((await app.inject(`/api/jobs/${first}`)).json<Job>().status).toBe("running");
      const second = await submit(app, png);
      expect((await app.inject(`/api/jobs/${second}`)).json<Job>().status).toBe("queued");
      await submit(app, png);
      await submit(app, png);
      expect((await app.inject(multipart(png))).statusCode).toBe(429);
      expect(engine.recognize).toHaveBeenCalledOnce();
    } finally { release(); }
    await result(app, first);
  });

  it("returns 404 for unknown/expired jobs and rejects nonlocal hosts/origins", async () => {
    const { app, png } = await setup();
    expect(HOST).toBe("127.0.0.1");
    expect((await app.inject("/api/jobs/missing")).statusCode).toBe(404);
    for (const headers of [{ host: "remote.example" }, { origin: "https://remote.example" }, { origin: "null" }]) {
      expect((await app.inject({ url: "/api/jobs/missing", headers })).statusCode).toBe(403);
    }
    const id = await submit(app, png);
    await result(app, id);
    const later = Date.now() + 31 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await app.inject(`/api/jobs/${id}`)).statusCode).toBe(404);
  });

  it("cancels through the local API, releases queued admission once, and keeps completed jobs", async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const engine = { recognize: vi.fn(async () => { await gate; return scaledWords; }) };
    const { app, png } = await setup(engine);
    const cancel = (id: string, headers = {}) => app.inject({ method: "POST", url: `/api/jobs/${id}/cancel`, headers });
    try {
      const first = await submit(app, png);
      await expect.poll(() => engine.recognize.mock.calls.length).toBe(1);
      const queued = await submit(app, png);
      await submit(app, png);
      await submit(app, png);
      expect((await app.inject(multipart(png))).statusCode).toBe(429);
      for (const headers of [{ host: "remote.example" }, { origin: "https://remote.example" }, { origin: "null" }]) {
        expect((await cancel(first, headers)).statusCode).toBe(403);
      }
      expect((await cancel("missing")).statusCode).toBe(404);
      expect((await cancel(queued)).json()).toEqual({ id: queued, status: "failed", error: "Cancelled" });
      await cancel(queued);
      await submit(app, png); // One freed slot, even after cancelling twice.
      expect((await app.inject(multipart(png))).statusCode).toBe(429);
      expect((await cancel(first)).json()).toEqual({ id: first, status: "failed", error: "Cancelled" });
      expect((await app.inject(multipart(png))).statusCode).toBe(429); // OCR still owns its admission slot.
      resume();
      const last = await submitAfterRelease();
      await result(app, last);
      expect((await cancel(last)).json<Job>().status).toBe("completed");
      expect((await app.inject(`/api/jobs/${first}`)).json<Job>()).toMatchObject({ status: "failed", error: "Cancelled" });
    } finally { resume(); }

    async function submitAfterRelease() {
      let id = "";
      await expect.poll(async () => {
        const response = await app.inject(multipart(png));
        if (response.statusCode === 202) id = response.json<{ id: string }>().id;
        return response.statusCode;
      }).toBe(202);
      return id;
    }
  });

  it("serves the client build without exposing server/source files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "imgtohtml-static-test-"));
    try {
      await writeFile(join(directory, "index.html"), "<!doctype html><title>Local app</title>");
      const app = await createApp({ clientRoot: directory, ocr: { recognize: async () => [] }, vision: new NullVisionModel() });
      apps.push(app);
      expect((await app.inject("/")).body).toContain("Local app");
      expect((await app.inject("/server/app.ts")).statusCode).toBe(404);
      expect((await app.inject("/api/missing")).statusCode).toBe(404);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
