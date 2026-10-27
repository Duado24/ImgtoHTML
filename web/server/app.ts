import Fastify, { type FastifyError } from "fastify";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { fileURLToPath } from "node:url";
import { isKind } from "../src/core/types";
import { MAX_UPLOAD_BYTES } from "../src/shared/api";
import { decodeImage, InvalidImage } from "./image";
import { Jobs } from "./jobs";
import { LocalOcr } from "./ocr";
import type { OcrEngine } from "./ocr/engine";

export const HOST = "127.0.0.1";
export const PORT = 3000;

interface AppOptions {
  ocr?: OcrEngine;
  /** false for API-only tests; the default is the Vite build directory. */
  clientRoot?: string | false;
  logger?: boolean;
}

export async function createApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_UPLOAD_BYTES });
  const jobs = new Jobs(options.ocr ?? new LocalOcr());
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
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 1024 * 1024 },
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
          if (!["kind", "label", "caption", "transcript"].includes(part.fieldname) || fields.has(part.fieldname)) {
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
      }, decoded, () => { active--; });
      submitted = true;
      return reply.code(202).header("Location", `/api/jobs/${id}`).send({ id });
    } finally {
      if (!submitted) active--;
    }
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found or expired. Convert the image again." });
    return job;
  });

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
