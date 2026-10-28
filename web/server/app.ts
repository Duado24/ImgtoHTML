import Fastify, { type FastifyError } from "fastify";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { fileURLToPath } from "node:url";
import { isKind } from "../src/core/types";
import { MAX_UPLOAD_BYTES } from "../src/shared/api";
import { BUILD_ID, STARTED } from "./build";
import { decodeImage, InvalidImage } from "./image";
import { Jobs, ReviewError } from "./jobs";
import type { Job } from "../src/shared/api";
import { LocalOcr } from "./ocr";
import type { OcrEngine } from "./ocr/engine";
import { NullVisionModel, OllamaVisionModel, type VisionModel } from "./vision";

export const HOST = "127.0.0.1";
export const PORT = 3000;

interface AppOptions {
  ocr?: OcrEngine;
  /** Default: Ollama on this computer, unless IMGTOHTML_VISION=off. */
  vision?: VisionModel;
  /** File for reviewer corrections; null keeps none. Default: web/corrections/corrections.jsonl. */
  corrections?: string | null;
  /** false for API-only tests; the default is the Vite build directory. */
  clientRoot?: string | false;
  logger?: boolean;
}

export async function createApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_UPLOAD_BYTES });
  const vision = options.vision ?? (process.env.IMGTOHTML_VISION === "off" ? new NullVisionModel() : new OllamaVisionModel());
  const jobs = new Jobs(options.ocr ?? new LocalOcr(), vision, options.corrections);
  let active = 0;
  app.addHook("onClose", async () => { await jobs.close(); });

  // A loopback bind alone does not prevent a remote page submitting a form
  // to localhost, or DNS rebinding. Accept only local hosts/origins.
  app.addHook("onRequest", async (request, reply) => {
    const local = (url: URL) => [HOST, "localhost"].includes(url.hostname);
    try {
      if (!local(new URL(`http://${request.headers.host}`)) ||
          (request.headers.origin && !local(new URL(request.headers.origin)))) {
        return reply.code(403).send({ error: "Only local requests are allowed." });
      }
    } catch {
      return reply.code(403).send({ error: "Only local requests are allowed." });
    }
  });
  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 6, fieldSize: 1024 * 1024 },
  });

  app.post("/api/convert", async (request, reply) => {
    if (!request.isMultipart()) return reply.code(415).send({ error: "Use a multipart image upload." });
    // Include uploads/decoding in admission control, not only queued OCR.
    if (active >= 4) return reply.code(429).send({ error: "The text reader is busy. Try again after a job finishes." });
    active++;
    let submitted = false;
    try {
      let image: Buffer | undefined;
      let fileName = "";
      const fields = new Map<string, string>();
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "image" || !part.filename) throw new InvalidImage("Choose a screenshot to convert.");
          fileName = part.filename.split(/[\\/]/).pop()!;
          image = await part.toBuffer();
        } else {
          if (!["kind", "label", "caption", "transcript", "window"].includes(part.fieldname) || fields.has(part.fieldname)) {
            throw new InvalidImage("Unexpected or duplicate form field.");
          }
          if (part.valueTruncated || part.fieldnameTruncated) return reply.code(413).send({ error: "A form field is too large (maximum 1 MB)." });
          fields.set(part.fieldname, String(part.value));
        }
      }
      if (!image?.length) throw new InvalidImage("Choose a screenshot to convert.");
      const kind = fields.get("kind") ?? "terminal";
      if (!isKind(kind)) throw new InvalidImage("Choose a supported screenshot type.");
      const decoded = await decodeImage(image, fileName);
      const id = jobs.submit({
        fileName, kind, label: fields.get("label"), caption: fields.get("caption"), transcript: fields.get("transcript"),
        editorWindow: fields.get("window") !== "off",
      }, decoded, () => { active--; });
      submitted = true;
      return reply.code(202).header("Location", `/api/jobs/${id}`).send({ id });
    } finally {
      if (!submitted) active--;
    }
  });

  app.get("/api/version", async () => ({ build: BUILD_ID, started: STARTED, pid: process.pid }));

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found or expired. Convert the image again." });
    return job;
  });

  // Review actions on a finished job. Each returns the job (retry: 202, then poll).
  const review = <B>(path: string, act: (id: string, body: B) => Job | Promise<Job> | void) =>
    app.post<{ Params: { id: string }; Body: B }>(`/api/jobs/:id/${path}`, async (request, reply) => {
      try {
        const job = await act(request.params.id, (request.body ?? {}) as B);
        return job ? job : reply.code(202).send({ id: request.params.id });
      } catch (error) {
        if (error instanceof ReviewError) return reply.code(409).send({ error: error.message });
        throw error;
      }
    });
  const text = (value: unknown, name: string, max = 200) => {
    if (typeof value !== "string" || value.length > max) throw new ReviewError(`Missing or too long: ${name}.`);
    return value;
  };
  review<{ region?: unknown; state?: unknown }>("decide", (id, body) => {
    if (body.state !== "approved" && body.state !== "skipped") throw new ReviewError("state must be approved or skipped.");
    return jobs.decide(id, text(body.region, "region"), body.state);
  });
  review<{ span?: unknown; text?: unknown }>("edit", (id, body) => jobs.edit(id, text(body.span, "span"), text(body.text, "text")));
  review<{ region?: unknown; hint?: unknown }>("retry", (id, body) =>
    jobs.retry(id, text(body.region, "region"), body.hint === undefined ? undefined : text(body.hint, "hint", 500)));

  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 500) app.log.error(error);
    reply.code(status).send({ error: status === 413 ? "Upload limit exceeded (image: 25 MB; text field: 1 MB)." : error.message });
  });

  if (options.clientRoot !== false) {
    await app.register(staticFiles, {
      root: options.clientRoot ?? fileURLToPath(new URL("../dist/", import.meta.url)),
      index: ["index.html"],
    });
  }
  return app;
}
