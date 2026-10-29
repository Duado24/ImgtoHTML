import type { Kind } from "../core/types";
import type { Job, JobProgress, JobResult } from "../shared/api";

export type ProgressCallback = (text: string, details?: JobProgress) => void;

export interface ConversionOptions {
  kind: Kind;
  label: string;
  caption: string;
  transcript?: string;
  /** Code: draw the editor window around the code (default true). */
  editorWindow?: boolean;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Local server returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

/** The browser only transfers the local file and displays the server's output. */
/** `onJob` receives the job ID, which review actions need. */
export async function convertOnServer(
  file: File,
  options: ConversionOptions,
  progress: ProgressCallback,
  onJob?: (id: string) => void,
): Promise<JobResult> {
  const form = new FormData();
  form.append("image", file);
  form.append("kind", options.kind);
  form.append("label", options.label);
  form.append("caption", options.caption);
  if (options.transcript !== undefined) form.append("transcript", options.transcript);
  if (options.editorWindow === false) form.append("window", "off");
  progress("Opening the image…", { progress: "Opening the image…", percent: 0, stage: "queued", step: 0, totalSteps: 5 });
  const { id } = await json<{ id: string }>("/api/convert", { method: "POST", body: form });
  onJob?.(id);
  return waitFor(id, progress);
}

const post = (id: string, action: string, body: object) =>
  json<Job | { id: string }>(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Cancellation is terminal on the server; polling observes its result. */
export async function cancelJob(id: string): Promise<Job> {
  return json<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

function done(job: Job | { id: string }): JobResult {
  if ("status" in job && job.status === "completed") return job.result;
  throw new Error("Unexpected reply from the local server.");
}

/** Mark a region (or "all" waiting regions) as approved or skipped. */
export async function decide(id: string, region: string, state: "approved" | "skipped"): Promise<JobResult> {
  return done(await post(id, "decide", { region, state }));
}

/** Replace one word (span) with the reviewer's text. */
export async function editSpan(id: string, span: string, text: string): Promise<JobResult> {
  return done(await post(id, "edit", { span, text }));
}

/** Read one region again, enlarged, with an optional hint for the vision model. */
export async function retryRegion(id: string, region: string, hint: string, progress: ProgressCallback, onQueued?: () => void): Promise<JobResult> {
  progress("Waiting for the text reader…", { progress: "Waiting for the text reader…", percent: 0, stage: "queued", step: 0, totalSteps: 5 });
  await post(id, "retry", hint ? { region, hint } : { region });
  onQueued?.();
  return waitFor(id, progress);
}

async function waitFor(id: string, progress: ProgressCallback): Promise<JobResult> {
  for (;;) {
    const job = await json<Job>(`/api/jobs/${encodeURIComponent(id)}`);
    if (job.status === "completed") {
      progress("Ready to review", { progress: "Ready to review", percent: 100, stage: "validate", step: 5, totalSteps: 5 });
      return job.result;
    }
    if (job.status === "failed") throw new Error(job.error);
    progress(job.progress, job);
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
  }
}
