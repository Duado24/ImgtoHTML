import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { convert, previewPage } from "../src/core/convert";
import { renderEditorWindow } from "../src/core/editor-window";
import { countWordsToCheck, type ModelRegion } from "../src/core/model";
import { plainLines } from "../src/core/paint";
import type { JobResult } from "../src/shared/api";
import { FakeImage } from "./image";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
const webRoot = resolve(import.meta.dirname, "..");

beforeAll(async () => {
  server = await createServer({
    configFile: false, root: webRoot, publicDir: false,
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: { ignored: ["**/eval-results/**"] } },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite test address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const pixels = new FakeImage(600, 150, [220, 40, 40]);
  pixels.fill(0, 50, 599, 99, [30, 180, 70]);
  pixels.fill(0, 100, 599, 149, [40, 80, 220]);
  const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="150">
    <rect width="600" height="50" fill="rgb(220,40,40)"/><rect y="50" width="600" height="50" fill="rgb(30,180,70)"/><rect y="100" width="600" height="50" fill="rgb(40,80,220)"/>
    <g fill="white" font-family="monospace" font-size="16"><text x="10" y="30">hello world</text><text x="10" y="80">wor1d</text><text x="10" y="130">cutoff…</text></g>
  </svg>`)).png().toBuffer();
  const regions: ModelRegion[] = [
    { id: "r1", words: ["hello", "world"], reason: "low-confidence" },
    { id: "r2", words: ["wor1d"], reason: "confusable" },
    { id: "r3", words: ["cutoff…"], reason: "cut-off" },
  ].map(({ id, words, reason }, i) => {
    const spans = words.map((text, j) => ({
      id: `${id}.l1.w${j + 1}`, text, source: "ocr" as const, confidence: 0.4,
      box: { x: 10 + j * 65, y: 15 + i * 50, width: 55, height: 16 },
      alternatives: id === "r2" ? [{ source: "vision" as const, text: "world", confidence: null }] : [],
    }));
    return {
      id, role: "code", box: { x: 0, y: i * 50, width: 600, height: 50 },
      background: "#1e1e1e", confidence: 0.4, review: "pending" as const,
      lines: [{ id: `${id}.l1`, box: { x: 10, y: 15 + i * 50, width: 120, height: 16 }, spans }],
      flags: [{ reason: reason as ModelRegion["flags"][number]["reason"], spanId: spans.at(-1)!.id, detail: `Technical OCR evidence for ${id}: 40% confidence` }],
    };
  });
  const words = regions.flatMap((region, i) => region.lines.flatMap((line) => line.spans.map((span) => ({
    ...span.box, text: span.text, confidence: 40, block: 0, paragraph: 0, line: i,
  }))));
  const base = convert({ fileName: "lesson.png", pixels, words, animated: false, kind: "code" });
  const imageDataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const result = (): JobResult => {
    const lines = regions.flatMap((region) => region.lines.map((line) => line.spans.map((span) => span.text).join(" ")));
    lines.push('const description = "' + "This code should wrap on every student screen. ".repeat(12) + '";');
    const html = renderEditorWindow(plainLines(lines), {
      sidebar: ["Explorer", "v lessons", "  lesson.ts"], header: ["lesson.ts X"], hints: [], firstLine: 1,
    }, "#d4d4d4", "Lesson code", null);
    const model = { ...base.model, width: 600, height: 150, regions };
    const review = { ...base.review, regions_to_review: regions.filter((r) => r.review === "pending").map((r) => ({ region: r.id, confidence: r.confidence, flags: r.flags.length })) };
    const converted = {
      ...base, html, model, review, transcript: lines.join("\n"), lowConfidenceCount: countWordsToCheck(model),
      htmlFile: { ...base.htmlFile, content: html }, modelFile: { ...base.modelFile, content: JSON.stringify(model) },
      reviewFile: { ...base.reviewFile, content: JSON.stringify(review) },
    };
    return { ...converted, imageDataUrl, preview: previewPage(converted, imageDataUrl) };
  };
  return { png, regions, result };
}

it("guides a teacher through original crops, approvals, fixes, skips and a focused retry", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { png, regions, result } = await fixture();
  const conversion = deferred();
  const retry = deferred();
  let retrying = false;
  let poll = 0;
  const edited = new Set<string>();
  const edits: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/convert") return route.fulfill({ json: { id: "lesson" }, status: 202 });
    if (path.endsWith("/retry")) {
      retrying = true;
      poll = 0;
      regions[2]!.review = "pending";
      return route.fulfill({ json: { id: "lesson" }, status: 202 });
    }
    if (path.endsWith("/edit")) {
      const body = request.postDataJSON() as { span: string; text: string };
      edits.push(body);
      const region = regions.find((r) => r.lines.some((line) => line.spans.some((span) => span.id === body.span)))!;
      region.lines.flatMap((line) => line.spans).find((span) => span.id === body.span)!.text = body.text;
      edited.add(region.id);
      return route.fulfill({ json: { id: "lesson", status: "completed", result: result() } });
    }
    if (path.endsWith("/decide")) {
      const body = request.postDataJSON() as { region: string; state: "approved" | "skipped" };
      const region = regions.find((r) => r.id === body.region)!;
      region.review = body.state === "approved" && edited.has(region.id) ? "corrected" : body.state;
      return route.fulfill({ json: { id: "lesson", status: "completed", result: result() } });
    }
    if (path === "/api/jobs/lesson") {
      if (poll++ === 0) return route.fulfill({ json: {
        id: "lesson", status: "running", progress: retrying ? "Reading this part again…" : "Reading text…",
        percent: retrying ? 35 : 40, stage: "read-text", step: 1, totalSteps: 5,
      } });
      await (retrying ? retry.promise : conversion.promise);
      return route.fulfill({ json: { id: "lesson", status: "completed", result: result() } });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  try {
    await page.goto(origin);
    await page.locator("#file").setInputFiles({ name: "lesson.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Convert", exact: true }).click();
    await browserExpect(page.locator("#progress")).toHaveAttribute("aria-valuenow", "40");
    await browserExpect(page.locator("#progress-label")).toHaveText("Step 1 of 5: Reading text — 40%");
    await browserExpect(page.locator("#progress")).toHaveAttribute("aria-valuemin", "0");
    await browserExpect(page.locator("#progress")).toHaveAttribute("aria-valuemax", "100");
    expect(await page.locator("#progress-fill").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    conversion.resolve();
    await browserExpect(page.locator("#review-title")).toHaveText("3 things to check before you paste this into Canvas");
    // One doubtful word per check; "hello" was read clearly and isn't counted.
    await browserExpect(page.locator("#s-low")).toHaveText("3");
    await browserExpect(page.locator("#review-count")).toHaveText("0 of 3 checked");
    await browserExpect(page.locator("#progress")).toHaveAttribute("aria-valuenow", "100");
    expect(await page.locator("#regions > li").first().getAttribute("data-region")).toBe("r3");
    await browserExpect(page.locator('#regions [data-region="r1"] .review-reason')).toHaveText("The text is blurry here: “world”.");
    await browserExpect(page.locator('#regions [data-region="r2"] .review-reason')).toContainText("1 (one)");
    await browserExpect(page.locator("#technical")).not.toHaveAttribute("open", "");
    await browserExpect(page.locator("#layout-status")).not.toBeVisible();
    await browserExpect(page.locator("#technical-files a").first()).not.toBeVisible();
    expect(await page.locator("#review").innerText()).not.toMatch(/\br1\b|confusable|confidence|Renderer:/);

    const first = page.locator('#regions [data-region="r1"]');
    await browserExpect(first.locator(".review-question")).toHaveText("Is this text the same as the picture?");
    await browserExpect(first.locator(".review-reading")).toHaveText("hello world");
    await browserExpect(first.locator(".review-reading mark")).toHaveText("world");
    await browserExpect(first.locator(".review-crop")).toHaveAttribute("aria-label", "This spot in the original screenshot");
    // The doubtful line (120 × 16 px, plus 8 px around it) is enlarged so its text is about 22 px tall, and shown at that size.
    await expect.poll(() => first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(187);
    expect(await first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.clientWidth)).toBe(187);
    expect(await first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => [...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data])).toEqual([220, 40, 40, 255]);
    const comparison = await first.locator("figure").evaluateAll((figures) => figures.map((figure) => ({ x: figure.getBoundingClientRect().x, y: figure.getBoundingClientRect().y })));
    expect(comparison[1]!.y).toBeGreaterThan(comparison[0]!.y);
    expect(comparison[1]!.x).toBe(comparison[0]!.x);
    await first.click();
    await browserExpect(page.locator('#boxes [data-region="r1"]')).toHaveClass(/active/);
    await page.locator('#boxes [data-region="r2"]').click();
    await browserExpect(page.locator('#regions [data-region="r2"]')).toHaveClass(/active/);

    const screenshots = resolve(webRoot, "eval-results");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, "review-checklist.png"), fullPage: true });
    await first.getByRole("button", { name: "Yes, it matches" }).click();
    await browserExpect(page.locator("#s-low")).toHaveText("2");
    await browserExpect(page.locator("#review-count")).toHaveText("1 of 3 checked");
    await browserExpect(page.locator("#review-progress")).toHaveAttribute("aria-valuenow", "33");

    const second = page.locator('#regions [data-region="r2"]');
    await second.getByRole("button", { name: "Fix it", exact: true }).click();
    await second.getByRole("button", { name: "Use “world”", exact: true }).click();
    await second.getByRole("button", { name: "Save fixes", exact: true }).click();
    await browserExpect(page.locator("#s-low")).toHaveText("1");
    await browserExpect(page.locator("#review-count")).toHaveText("2 of 3 checked");
    expect(edits).toEqual([{ span: "r2.l1.w1", text: "world" }]);
    await browserExpect(second.locator(".review-reading")).toHaveText("world");
    await browserExpect(second).toHaveClass(/checked/);

    const third = page.locator('#regions [data-region="r3"]');
    await third.getByRole("button", { name: "Skip for now", exact: true }).click();
    await browserExpect(page.locator("#s-low")).toHaveText("0");
    await browserExpect(page.locator("#review-count")).toHaveText("2 of 3 checked");
    await browserExpect(page.locator("#review-title")).toHaveText("1 thing to check before you paste this into Canvas");
    await browserExpect(page.locator("#review-skipped")).toContainText("1 skipped for now");
    await browserExpect(page.locator("#status")).toContainText("unverified");
    await third.getByRole("button", { name: "Fix it", exact: true }).click();
    await third.getByText("Read this spot again", { exact: true }).click();
    await third.getByRole("button", { name: "Focus here", exact: true }).click();
    await browserExpect(page.locator("#progress")).toHaveAttribute("aria-valuenow", "35");
    await browserExpect(page.locator("#progress-label")).toHaveText("Step 1 of 5: Reading this part again — 35%");
    retry.resolve();
    await browserExpect(page.locator("#s-low")).toHaveText("1");
    await third.getByRole("button", { name: "Yes, it matches" }).click();
    await browserExpect(page.locator("#review-title")).toHaveText("Ready to paste");
    await browserExpect(page.locator("#review-count")).toHaveText("3 of 3 checked");
    await browserExpect(page.locator("#review-progress")).toHaveAttribute("aria-valuenow", "100");
    await browserExpect(page.locator("#s-low")).toHaveText("0");

    await page.getByText("Phone 375", { exact: true }).click();
    const frame = page.locator("#render");
    await expect.poll(() => frame.evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow!.innerWidth)).toBe(375);
    expect(await frame.evaluate((iframe: HTMLIFrameElement) => {
      const doc = iframe.contentDocument!;
      const win = iframe.contentWindow!;
      const clipped: string[] = [];
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        const range = doc.createRange();
        for (const word of text.textContent!.matchAll(/\S+/g)) {
          range.setStart(text, word.index);
          range.setEnd(text, word.index + word[0].length);
          for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            let cut = rect.left < -1 || rect.right > win.innerWidth + 1;
            for (let ancestor = text.parentElement; ancestor && !cut; ancestor = ancestor.parentElement) {
              if (!/hidden|clip/.test(win.getComputedStyle(ancestor).overflowX)) continue;
              const bounds = ancestor.getBoundingClientRect();
              cut = rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
            }
            if (cut) clipped.push(word[0]);
          }
        }
      }
      return { overflow: doc.documentElement.scrollWidth - win.innerWidth, tables: doc.querySelectorAll("table").length, clipped };
    })).toEqual({ overflow: 0, tables: 0, clipped: [] });
    await frame.screenshot({ path: resolve(screenshots, "phone375-preview.png") });
    await page.setViewportSize({ width: 375, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    conversion.resolve();
    retry.resolve();
    await page.close();
  }
}, 30_000);
