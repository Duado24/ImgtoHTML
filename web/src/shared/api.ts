import type { ConvertResult, OutputFile } from "../core/convert";

export const SUPPORTED = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"] as const;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface JobResult extends ConvertResult {
  preview: OutputFile;
  /** Decoded final frame, also displayable when the source is a TIFF. */
  imageDataUrl: string;
}

export type JobStage = "queued" | "read-text" | "detect-layout" | "vision" | "render" | "validate";

/** Percent is weighted across the whole operation, including any OCR re-reads. */
export interface JobProgress {
  progress: string;
  percent: number;
  stage: JobStage;
  step: number;
  totalSteps: 5;
}

export type Job =
  | ({ id: string; status: "queued" | "running" } & JobProgress)
  | { id: string; status: "completed"; result: JobResult }
  | { id: string; status: "failed"; error: string };
