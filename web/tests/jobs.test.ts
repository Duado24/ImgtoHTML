import { afterEach, describe, expect, it, vi } from "vitest";
import { Jobs } from "../server/jobs";
import { NullVisionModel, type VisionModel } from "../server/vision";
import type { OcrEngine } from "../server/ocr/engine";
import type { OcrWord } from "../src/core/types";
import { FakeImage } from "./image";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const stores: Jobs[] = [];
const unblock: (() => void)[] = [];
afterEach(async () => {
  unblock.splice(0).forEach((f) => f());
  await Promise.all(stores.splice(0).map((jobs) => jobs.close()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup(engine: OcrEngine = { recognize: async () => [] }, vision: VisionModel = new NullVisionModel()) {
  const jobs = new Jobs(engine, vision, null);
  stores.push(jobs);
  return jobs;
}

function submit(jobs: Jobs, size = 40) {
  const released = deferred<void>();
  const release = vi.fn(() => released.resolve());
  const id = jobs.submit({ fileName: "a.png", kind: "terminal" }, {
    pixels: new FakeImage(size, size, [30, 30, 30]), png: Buffer.from("png"), animated: false,
  }, release);
  return { id, release, settled: released.promise };
}

function gatedEngine() {
  const started = deferred<void>();
  const gate = deferred<OcrWord[]>();
  unblock.push(() => gate.resolve([]));
  const recognize = vi.fn().mockImplementationOnce(() => { started.resolve(); return gate.promise; }).mockResolvedValue([]);
  return { recognize, started: started.promise, resume: () => gate.resolve([]) };
}

describe("job lifecycle", () => {
  it("reports weighted, monotonic OCR progress and plain steps through layout and vision", async () => {
    const started = deferred<void>();
    const read = deferred<OcrWord[]>();
    const layoutStarted = deferred<void>();
    const layout = deferred<{ layout: null; attempts: [] }>();
    const visionStarted = deferred<void>();
    const vision = deferred<[]>();
    unblock.push(() => { read.resolve([]); layout.resolve({ layout: null, attempts: [] }); vision.resolve([]); });
    let report: ((percent: number) => void) | undefined;
    const jobs = setup({ recognize: async (_image, progress) => {
      report = progress;
      started.resolve();
      return read.promise;
    } }, {
      name: "test",
      detectLayout: async () => { layoutStarted.resolve(); return layout.promise; },
      analyze: async () => { visionStarted.resolve(); return vision.promise; },
    });
    const job = submit(jobs);
    expect(jobs.get(job.id)).toMatchObject({ status: "queued", percent: 0, stage: "queued", step: 0, totalSteps: 5 });
    await started.promise;
    expect(jobs.get(job.id)).toMatchObject({ status: "running", percent: 5, stage: "read-text", step: 1 });
    report?.(75);
    expect(jobs.get(job.id)).toMatchObject({ percent: 20 }); // 75% of initial OCR's share.
    report?.(10);
    expect(jobs.get(job.id)).toMatchObject({ percent: 20 });
    read.resolve([]);
    await layoutStarted.promise;
    expect(jobs.get(job.id)).toMatchObject({ percent: 55, stage: "detect-layout", step: 2 });
    layout.resolve({ layout: null, attempts: [] });
    await visionStarted.promise;
    expect(jobs.get(job.id)).toMatchObject({ percent: 65, stage: "vision", step: 3 });
    vision.resolve([]);
    await job.settled;
    expect(jobs.get(job.id)?.status).toBe("completed");
    report?.(100); // A late logger event must never overwrite a terminal result.
    expect(jobs.get(job.id)?.status).toBe("completed");
  });

  it("starts a region reread at zero and supplies the same weighted OCR progress", async () => {
    const retryStarted = deferred<void>();
    const reread = deferred<OcrWord[]>();
    unblock.push(() => reread.resolve([]));
    let report: ((percent: number) => void) | undefined;
    const recognize = vi.fn().mockResolvedValueOnce([{ text: "hello", x: 54, y: 54, width: 30, height: 30, confidence: 40, block: 0, paragraph: 0, line: 0 }])
      .mockImplementationOnce(async (_image, progress) => { report = progress; retryStarted.resolve(); return reread.promise; });
    const jobs = setup({ recognize });
    const job = submit(jobs);
    await job.settled;
    const finished = jobs.get(job.id);
    expect(finished?.status).toBe("completed");
    if (finished?.status !== "completed") throw new Error("Initial job did not finish");
    jobs.retry(job.id, finished.result.model.regions[0]!.id);
    expect(jobs.get(job.id)).toMatchObject({ status: "running", percent: 0, stage: "queued" });
    await retryStarted.promise;
    report?.(50);
    expect(jobs.get(job.id)).toMatchObject({ percent: 15, stage: "read-text", step: 1, totalSteps: 5 });
    reread.resolve([]);
    await expect.poll(() => jobs.get(job.id)?.status).toBe("completed");
  });

  it("cancels a queued job once without invoking its OCR or affecting other jobs", async () => {
    const engine = gatedEngine();
    const jobs = setup(engine);
    const first = submit(jobs);
    await engine.started;
    const queued = submit(jobs);
    const next = submit(jobs);
    expect(jobs.get(queued.id)?.status).toBe("queued");
    expect(jobs.cancel(queued.id)).toEqual({ id: queued.id, status: "failed", error: "Cancelled" });
    jobs.cancel(queued.id);
    expect(queued.release).toHaveBeenCalledOnce();
    expect(engine.recognize).toHaveBeenCalledOnce();
    engine.resume();
    await next.settled;
    expect(jobs.get(first.id)?.status).toBe("completed");
    expect(jobs.get(next.id)?.status).toBe("completed");
    expect(jobs.get(queued.id)?.status).toBe("failed");
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(first.release).toHaveBeenCalledOnce();
    expect(queued.release).toHaveBeenCalledOnce();
    expect(next.release).toHaveBeenCalledOnce();
  });

  it("cancels running OCR immediately but holds the worker until late OCR settles", async () => {
    const engine = gatedEngine();
    const analyze = vi.fn(async () => []);
    const jobs = setup(engine, { name: "test", analyze });
    const first = submit(jobs);
    await engine.started;
    const next = submit(jobs);
    jobs.cancel(first.id);
    jobs.cancel(first.id);
    expect(jobs.get(first.id)).toEqual({ id: first.id, status: "failed", error: "Cancelled" });
    expect(first.release).not.toHaveBeenCalled();
    expect(jobs.get(next.id)?.status).toBe("queued");
    engine.resume();
    await next.settled;
    expect(first.release).toHaveBeenCalledOnce();
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledOnce(); // Only the next job reaches vision.
    expect(jobs.get(first.id)?.status).toBe("failed");
    expect(jobs.get(next.id)?.status).toBe("completed");
  });

  it("discards a late Ollama layout result and stops before its next vision step", async () => {
    const started = deferred<void>();
    const gate = deferred<{ layout: null; attempts: [] }>();
    unblock.push(() => gate.resolve({ layout: null, attempts: [] }));
    const analyze = vi.fn(async () => []);
    const jobs = setup(undefined, { name: "test", analyze, detectLayout: async () => { started.resolve(); return gate.promise; } });
    const job = submit(jobs);
    await started.promise;
    jobs.cancel(job.id);
    gate.resolve({ layout: null, attempts: [] });
    await job.settled;
    expect(analyze).not.toHaveBeenCalled();
    expect(jobs.get(job.id)).toEqual({ id: job.id, status: "failed", error: "Cancelled" });
    expect(job.release).toHaveBeenCalledOnce();
  });

  it("leaves completion unchanged when cancellation arrives afterwards", async () => {
    const jobs = setup();
    const job = submit(jobs);
    await job.settled;
    const result = jobs.get(job.id);
    expect(result?.status).toBe("completed");
    expect(jobs.cancel(job.id)).toBe(result);
    expect(job.release).toHaveBeenCalledOnce();
  });

  it("applies the overall deadline to running and queued work and discards late success", async () => {
    vi.stubEnv("IMGTOHTML_JOB_TIMEOUT_MS", "60000");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const engine = gatedEngine();
    const jobs = setup(engine);
    const first = submit(jobs);
    await engine.started;
    const queued = submit(jobs);
    await vi.advanceTimersByTimeAsync(60_000);
    for (const { id } of [first, queued]) expect(jobs.get(id)).toEqual({ id, status: "failed", error: "Timed out after 1 minutes" });
    expect(first.release).not.toHaveBeenCalled();
    expect(queued.release).toHaveBeenCalledOnce();
    jobs.cancel(first.id); // The first terminal reason wins.
    engine.resume();
    await first.settled;
    expect(jobs.get(first.id)).toMatchObject({ status: "failed", error: "Timed out after 1 minutes" });
    expect(first.release).toHaveBeenCalledOnce();
    expect(engine.recognize).toHaveBeenCalledOnce();
  });

  it.each(["0", "-1", "nope", "Infinity"])("warns at startup and uses the default deadline for %s", async (value) => {
    vi.stubEnv("IMGTOHTML_JOB_TIMEOUT_MS", value);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = gatedEngine();
    const jobs = setup(engine);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("using 600000"));
    const job = submit(jobs);
    await engine.started;
    await vi.advanceTimersByTimeAsync(599_999);
    expect(jobs.get(job.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(jobs.get(job.id)).toMatchObject({ status: "failed", error: "Timed out after 10 minutes" });
  });
});

describe("retained memory", () => {
  it("evicts oldest finished jobs by budget after their full 60-second grace, even if fetched", async () => {
    vi.stubEnv("IMGTOHTML_MEMORY_BUDGET_MB", "1");
    let now = Date.now();
    const initial = now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const jobs = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      now = initial + i;
      const job = submit(jobs, 320); // ~410 KB decoded; 3 results exceed 1 MB.
      await job.settled;
      ids.push(job.id);
      expect(jobs.get(job.id)?.status).toBe("completed");
    }
    now = initial + 59_999;
    ids.forEach((id) => expect(jobs.get(id)?.status).toBe("completed"));
    now = initial + 60_000;
    expect(jobs.get(ids[0]!)).toBeUndefined();
    ids.slice(1).forEach((id) => expect(jobs.get(id)?.status).toBe("completed"));
  });

  it.each([true, false])("logs and retains an oversized result until fetched or grace expires (fetch: %s)", async (fetch) => {
    vi.stubEnv("IMGTOHTML_MEMORY_BUDGET_MB", "0.1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const jobs = setup();
    const job = submit(jobs, 320);
    await job.settled;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeding"));
    if (fetch) {
      expect(jobs.get(job.id)?.status).toBe("completed");
    } else {
      clock.mockReturnValue(now + 60_000);
    }
    expect(jobs.get(job.id)).toBeUndefined();
  });

  it("also bounds finished job count, while respecting grace", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const jobs = setup();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const job = submit(jobs);
      await job.settled;
      ids.push(job.id);
    }
    ids.forEach((id) => expect(jobs.get(id)?.status).toBe("completed"));
    clock.mockReturnValue(now + 60_000);
    expect(jobs.get(ids[0]!)).toBeUndefined();
    expect(jobs.get(ids[1]!)).toBeUndefined();
    ids.slice(2).forEach((id) => expect(jobs.get(id)?.status).toBe("completed"));
  });
});
