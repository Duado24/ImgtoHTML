import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
const webRoot = resolve(import.meta.dirname, "..");

beforeAll(async () => {
  server = await createServer({
    configFile: resolve(webRoot, "vite.config.ts"), root: webRoot,
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: { ignored: ["**/eval-results/**", "**/fixtures/**"] } },
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

const report = {
  format: "imgtohtml-report", version: 1, kind: "code", application: "ide", language: "json",
  regions: [
    { id: "files", type: "sidebar", parent: null, box: { x: 0, y: 0, width: 250, height: 1000 }, lines: ["EXPLORER", "⌄ web", "  package.json"] },
    { id: "tabs", type: "tabs", parent: null, box: { x: 250, y: 0, width: 750, height: 60 }, lines: ["package.json"] },
    { id: "code", type: "code", parent: null, box: { x: 250, y: 60, width: 750, height: 940 },
      lines: ["{", '  "name": "imgtohtml-web",', '  "description": "' + "A long description that students read on their phones. ".repeat(4) + 'and Nod', "}"],
      cut_off_lines: [3], unsure_words: ["imgtohtml-web"] },
  ],
};

async function paste(page: Page, text: string) {
  await page.locator("#report").fill(text);
}

/** Words drawn outside the frame, or cut off by an element that hides overflow. */
async function clipped(page: Page) {
  return page.locator("#render").evaluate((iframe: HTMLIFrameElement) => {
    const doc = iframe.contentDocument!;
    const win = iframe.contentWindow!;
    const words: string[] = [];
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
          if (cut) words.push(word[0]);
        }
      }
    }
    return { overflow: doc.documentElement.scrollWidth - win.innerWidth, tables: doc.querySelectorAll("table").length, words };
  });
}

it("turns a pasted report into Canvas HTML, with a checklist, fixes and a phone-safe preview", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    await browserExpect(page.locator("#empty")).toBeVisible();
    // No upload anywhere: the report is the only input.
    expect(await page.locator('input[type="file"]').count()).toBe(0);
    await browserExpect(page.locator("#instructions")).toContainText("imgtohtml-report");

    // A broken report: every problem listed, nothing converted.
    await paste(page, '{"format":"imgtohtml-report","version":2}');
    await browserExpect(page.locator("#report-status")).toContainText("Send them back to the AI");
    await browserExpect(page.locator("#report-status li")).toHaveCount(4);
    await browserExpect(page.locator("#results")).toBeHidden();

    // A good one, fenced as a chat hands it over.
    await paste(page, "Here you go:\n```json\n" + JSON.stringify(report, null, 2) + "\n```");
    await browserExpect(page.locator("#results")).toBeVisible();
    await browserExpect(page.locator("#report-status")).toContainText("Report ready: code screenshot, 3 parts.");
    await browserExpect(page.locator("#review-title")).toHaveText("1 thing to check before you paste this into Canvas");
    await browserExpect(page.locator("#s-low")).toHaveText("2"); // one unsure word + one cut-off line
    await browserExpect(page.locator("#regions")).toBeHidden(); // the checklist is a closed dropdown
    await browserExpect(page.locator("#code")).toContainText("<em>package.json</em>");
    await browserExpect(page.locator("#label")).toHaveAttribute("placeholder", "JSON code: EXPLORER");

    await page.locator("#review > summary").click();
    const card = page.locator('#regions [data-region="code"]');
    await browserExpect(card.locator("mark")).toHaveText(["imgtohtml-web", "…"]);
    await browserExpect(card.locator(".review-reason").first()).toHaveText("The AI wasn't sure it read these right: “imgtohtml-web”.");

    // Fix it: the text changes on the page and in the report.
    await card.getByRole("button", { name: "Fix it", exact: true }).click();
    const area = card.locator("textarea");
    await area.fill((await area.inputValue()).replace("imgtohtml-web", "imgtohtml-app"));
    await card.getByRole("button", { name: "Save fix", exact: true }).click();
    await browserExpect(page.locator("#review-title")).toHaveText("Ready to paste");
    await browserExpect(page.locator("#s-low")).toHaveText("0");
    await browserExpect(page.locator("#code")).toContainText("imgtohtml-app");
    expect(await page.locator("#report").inputValue()).toContain("imgtohtml-app");

    // The label and caption change the HTML right away.
    await page.locator("#label").fill("package.json for the web app");
    await browserExpect(page.locator("#code")).toContainText('aria-label="package.json for the web app"');

    // Phone width: nothing scrolls sideways, nothing is clipped, no tables.
    await page.getByText("Phone 375", { exact: true }).click();
    await expect.poll(() => page.locator("#render").evaluate((iframe: HTMLIFrameElement) => iframe.contentWindow!.innerWidth)).toBe(375);
    expect(await clipped(page)).toEqual({ overflow: 0, tables: 0, words: [] });

    // The ChatGPT button is a placeholder until the GPT is published.
    await browserExpect(page.locator("#plugin")).toContainText("Coming soon");
    await page.locator("#plugin").dispatchEvent("click"); // Playwright won't click aria-disabled; a person can
    await browserExpect(page.locator("#report-status")).toContainText("coming soon");

    const shots = resolve(webRoot, "eval-results");
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: resolve(shots, "report-page.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
