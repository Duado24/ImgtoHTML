import type { Kind } from "../core/types";
import type { Job, JobResult } from "../shared/api";

export interface ConversionOptions {
  kind: Kind;
  label: string;
  caption: string;
  transcript?: string;
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
  progress: (text: string) => void,
  onJob?: (id: string) => void,
): Promise<JobResult> {
  const form = new FormData();
  form.append("image", file);
  form.append("kind", options.kind);
  form.append("label", options.label);
  form.append("caption", options.caption);
  if (options.transcript !== undefined) form.append("transcript", options.transcript);
  progress("Opening the image…");
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
export async function retryRegion(id: string, region: string, hint: string, progress: (text: string) => void): Promise<JobResult> {
  await post(id, "retry", hint ? { region, hint } : { region });
  return waitFor(id, progress);
}

async function waitFor(id: string, progress: (text: string) => void): Promise<JobResult> {
  for (;;) {
    const job = await json<Job>(`/api/jobs/${encodeURIComponent(id)}`);
    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new Error(job.error);
    progress(job.progress);
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
  }
}
