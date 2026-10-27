import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createApp } from "../server/app";
import { NullVisionModel, type VisionModel } from "../server/vision";
import type { Job, JobResult } from "../src/shared/api";
import { issuesFor } from "../src/core/convert";
import type { OcrWord } from "../src/core/types";
import { FakeImage } from "./image";

type App = Awaited<ReturnType<typeof createApp>>;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((f) => f())); });

// Two words; "wor1d" is uncertain, so its region is flagged for review.
const words: OcrWord[] = [
  { text: "hello", x: 10, y: 10, width: 50, height: 14, confidence: 96, block: 0, paragraph: 0, line: 0 },
  { text: "wor1d", x: 70, y: 10, width: 50, height: 14, confidence: 40, block: 0, paragraph: 0, line: 0 },
];
// The engine sees the preprocessed image: 8 px margin, enlarged 3×.
const scaled = (ws: OcrWord[]) => ws.map((w) => ({ ...w, x: (w.x + 8) * 3, y: (w.y + 8) * 3, width: w.width * 3, height: w.height * 3 }));

async function setup(vision: VisionModel = new NullVisionModel()) {
  const dir = await mkdtemp(join(tmpdir(), "imgtohtml-review-"));
  const corrections = join(dir, "corrections.jsonl");
  const recognize = vi.fn().mockResolvedValue(scaled(words));
  const app = await createApp({ ocr: { recognize }, vision, clientRoot: false, corrections });
  cleanup.push(() => app.close(), () => rm(dir, { recursive: true, force: true }));
  const pixels = new FakeImage(200, 40, [30, 30, 30]);
  for (const w of words) pixels.fill(w.x, w.y, w.x + w.width - 1, w.y + w.height - 1, [212, 212, 212]);
  const png = await sharp(Buffer.from(pixels.data), { raw: { width: 200, height: 40, channels: 4 } }).png().toBuffer();
  const boundary = "b";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n\r\n`), png,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nterminal\r\n--${boundary}--\r\n`),
  ]);
  const { id } = (await app.inject({ method: "POST", url: "/api/convert", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload })).json<{ id: string }>();
  return { app, id, recognize, corrections, first: await poll(app, id) };
}

async function poll(app: App, id: string): Promise<JobResult> {
  let job: Job;
  await expect.poll(async () => {
    job = (await app.inject(`/api/jobs/${id}`)).json<Job>();
    return job.status === "completed" || job.status === "failed";
  }).toBe(true);
  if (job!.status !== "completed") throw new Error(JSON.stringify(job!));
  return job!.result;
}

const post = (app: App, id: string, action: string, body: object) =>
  app.inject({ method: "POST", url: `/api/jobs/${id}/${action}`, payload: body });

describe("review actions", () => {
  it("flags the uncertain region, then approving it settles it", async () => {
    const { app, id, first } = await setup();
    expect(first.review.regions_to_review).toEqual([expect.objectContaining({ region: "r1" })]);
    const response = await post(app, id, "decide", { region: "r1", state: "approved" });
    const job = response.json<Job>();
    expect(job.status === "completed" && job.result.model.regions[0]!.review).toBe("approved");
    expect(job.status === "completed" && job.result.review.regions_to_review).toEqual([]);
    expect(issuesFor(first).some((i) => i.text.includes("low-confidence"))).toBe(true);
    expect(job.status === "completed" && issuesFor(job.result).some((i) => i.text.includes("low-confidence"))).toBe(false);
  });

  it("edits a word, records the correction, and approving then records 'corrected'", async () => {
    const { app, id, first, corrections } = await setup();
    const span = first.model.regions[0]!.lines[0]!.spans[1]!;
    const edited = post(app, id, "edit", { span: span.id, text: "world" });
    const job = (await edited).json<Job>();
    expect(job.status === "completed" && job.result.transcript).toBe("hello world");
    expect(job.status === "completed" && job.result.html).toContain("world");
    const saved = JSON.parse((await readFile(corrections, "utf8")).trim());
    expect(saved).toMatchObject({ file: "a.png", span: span.id, ocr: "wor1d", user: "world" });
    const approved = (await post(app, id, "decide", { region: "r1", state: "approved" })).json<Job>();
    expect(approved.status === "completed" && approved.result.model.regions[0]!.review).toBe("corrected");
  });

  it("skips every waiting region at once", async () => {
    const { app, id } = await setup();
    const job = (await post(app, id, "decide", { region: "all", state: "skipped" })).json<Job>();
    expect(job.status === "completed" && job.result.model.regions.map((r) => r.review)).toEqual(["skipped"]);
  });

  it("re-reads one region on its own and asks the vision model with the hint", async () => {
    const analyze = vi.fn(async (_image, regions: readonly { id: string }[], _focus?: { hint?: string }) =>
      regions.map((r) => ({ regionId: r.id, role: "terminal", text: "hello world" })));
    const { app, id, recognize } = await setup({ name: "fake", analyze });
    const before = recognize.mock.calls.length;
    expect((await post(app, id, "retry", { region: "r1", hint: "it says world" })).statusCode).toBe(202);
    const after = await poll(app, id);
    expect(recognize.mock.calls.length).toBeGreaterThan(before);
    expect(analyze).toHaveBeenLastCalledWith(expect.anything(), [expect.objectContaining({ id: "r1" })], { hint: "it says world" });
    const alternatives = after.model.regions[0]!.lines[0]!.spans[1]!.alternatives;
    expect(alternatives).toEqual([{ source: "vision", text: "world", confidence: null }]);
  });

  it("refuses bad requests with a message", async () => {
    const { app, id, first } = await setup();
    const span = first.model.regions[0]!.lines[0]!.spans[1]!.id;
    expect((await post(app, id, "edit", { span, text: "two words" })).json()).toEqual({ error: "Enter one word, without spaces." });
    expect((await post(app, id, "decide", { region: "r1", state: "maybe" })).statusCode).toBe(409);
    expect((await post(app, "nope", "decide", { region: "r1", state: "approved" })).statusCode).toBe(409);
  });
});
