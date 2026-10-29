import { afterEach, expect, it, vi } from "vitest";
import { cancelJob, convertOnServer, retryRegion } from "../src/browser/api";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const file = new File(["image bytes"], "a.png", { type: "image/png" });
const options = { kind: "terminal" as const, label: "", caption: "", transcript: "corrected text" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("uploads the selected file and fields, polls progress, then returns server output", async () => {
  vi.useFakeTimers();
  const output = { html: "<div>draft</div>", transcript: "corrected text", preview: { name: "a_preview.html" } };
  const fetch = vi.fn().mockResolvedValueOnce(response({ id: "job-id" }, 202))
    .mockResolvedValueOnce(response({ id: "job-id", status: "queued", progress: "Waiting", percent: 0, stage: "queued", step: 0, totalSteps: 5 }))
    .mockResolvedValueOnce(response({ id: "job-id", status: "running", progress: "Reading panel 2", percent: 40, stage: "read-text", step: 1, totalSteps: 5 }))
    .mockResolvedValueOnce(response({ id: "job-id", status: "completed", result: output }));
  vi.stubGlobal("fetch", fetch);
  const progress = vi.fn();
  const promise = convertOnServer(file, options, progress);
  await vi.runAllTimersAsync();
  expect(await promise).toEqual(output);
  const [url, request] = fetch.mock.calls[0]!;
  expect(url).toBe("/api/convert");
  expect(request.method).toBe("POST");
  expect(request.body.get("image").name).toBe("a.png");
  expect(request.body.get("kind")).toBe("terminal");
  expect(request.body.get("label")).toBe("");
  expect(request.body.get("caption")).toBe("");
  expect(request.body.get("transcript")).toBe("corrected text");
  expect(fetch.mock.calls.slice(1).map(([path]) => path)).toEqual(Array(3).fill("/api/jobs/job-id"));
  expect(progress.mock.calls.map(([message]) => message)).toEqual(["Opening the image…", "Waiting", "Reading panel 2", "Ready to review"]);
  expect(progress.mock.calls.map(([, details]) => details.percent)).toEqual([0, 0, 40, 100]);
  expect(progress.mock.calls[2]![1]).toMatchObject({ stage: "read-text", step: 1, totalSteps: 5 });
});

it("reports the same determinate progress for a focused region retry", async () => {
  vi.useFakeTimers();
  const output = { html: "<div>updated</div>" };
  const fetch = vi.fn().mockResolvedValueOnce(response({ id: "job/id" }, 202))
    .mockResolvedValueOnce(response({ id: "job/id", status: "running", progress: "Reading this part again…", percent: 15, stage: "read-text", step: 1, totalSteps: 5 }))
    .mockResolvedValueOnce(response({ id: "job/id", status: "completed", result: output }));
  vi.stubGlobal("fetch", fetch);
  const progress = vi.fn();
  const queued = vi.fn();
  const promise = retryRegion("job/id", "r1", "Look here", progress, queued);
  await vi.runAllTimersAsync();
  expect(await promise).toEqual(output);
  expect(queued).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toBe("/api/jobs/job%2Fid/retry");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ region: "r1", hint: "Look here" });
  expect(progress.mock.calls.map(([, details]) => details.percent)).toEqual([0, 15, 100]);
});

it("surfaces upload errors and failed jobs", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ error: "Invalid image" }, 400));
  vi.stubGlobal("fetch", fetch);
  await expect(convertOnServer(file, options, () => {})).rejects.toThrow("Invalid image");
  fetch.mockResolvedValueOnce(response({ id: "job-id" }, 202))
    .mockResolvedValueOnce(response({ id: "job-id", status: "failed", error: "Tesseract failed" }));
  await expect(convertOnServer(file, options, () => {})).rejects.toThrow("Tesseract failed");
});

it("posts cancellation for the encoded job ID and surfaces failures", async () => {
  const cancelled = { id: "job/id", status: "failed", error: "Cancelled" };
  const fetch = vi.fn().mockResolvedValueOnce(response(cancelled));
  vi.stubGlobal("fetch", fetch);
  expect(await cancelJob("job/id")).toEqual(cancelled);
  expect(fetch.mock.calls[0]![0]).toBe("/api/jobs/job%2Fid/cancel");
  expect(fetch.mock.calls[0]![1].method).toBe("POST");
  fetch.mockResolvedValueOnce(response({ error: "Job not found" }, 404));
  await expect(cancelJob("missing")).rejects.toThrow("Job not found");
});
