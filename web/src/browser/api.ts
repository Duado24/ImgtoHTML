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
export async function convertOnServer(file: File, options: ConversionOptions, progress: (text: string) => void): Promise<JobResult> {
  const form = new FormData();
  form.append("image", file);
  form.append("kind", options.kind);
  form.append("label", options.label);
  form.append("caption", options.caption);
  if (options.transcript !== undefined) form.append("transcript", options.transcript);
  progress("Opening the image…");
  const { id } = await json<{ id: string }>("/api/convert", { method: "POST", body: form });
  for (;;) {
    const job = await json<Job>(`/api/jobs/${encodeURIComponent(id)}`);
    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new Error(job.error);
    progress(job.progress);
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
  }
}
