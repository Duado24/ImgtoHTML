import type { ConvertResult, OutputFile } from "../core/convert";

export const SUPPORTED = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"] as const;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface JobResult extends ConvertResult {
  preview: OutputFile;
  /** Decoded final frame, also displayable when the source is a TIFF. */
  imageDataUrl: string;
}

export type Job =
  | { id: string; status: "queued" | "running"; progress: string }
  | { id: string; status: "completed"; result: JobResult }
  | { id: string; status: "failed"; error: string };
