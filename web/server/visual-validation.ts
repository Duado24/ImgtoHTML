import sharp from "sharp";
import type { VisionLayout } from "../src/core/vision-layout";

export interface VisualReport {
  discrepancies: { component: string; error: number }[];
  pixelMeanAbsoluteError: number;
  repaired: boolean;
  html: string;
}
/** Opt-in browser validation. Exported HTML remains script-free; browser code only measures it.
 * Pixel error is diagnostic: OCR font differences are not grounds for rewriting text. */
export async function validateVisual(html: string, original: Buffer, layout: VisionLayout, width: number, height: number, screenshot?: string): Promise<VisualReport> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
    const measure = () => page.evaluate(({ components, width, height }) => components.flatMap((c) => {
      const el = document.getElementById(`layout-${c.id}`);
      if (!el) return [{ component: c.id, error: 1 }];
      const b = el.getBoundingClientRect();
      const error = Math.max(Math.abs(b.x - c.box.x) / width, Math.abs(b.y - c.box.y) / height, Math.abs(b.width - c.box.width) / width, Math.abs(b.height - c.box.height) / height);
      return error > 0.08 ? [{ component: c.id, error }] : [];
    }), { components: layout.components, width, height });
    let discrepancies = await measure();
    let repaired = false;
    if (discrepancies.length) {
      // Repair column widths / cell padding altered by inherited host styling.
      // Only inline structural CSS is changed; text nodes remain untouched.
      const before = await page.locator('body').innerText();
      await page.evaluate((components) => {
        for (const c of components) {
          const el = document.getElementById(`layout-${c.id}`);
          const cell = el?.parentElement;
          if (cell?.tagName !== 'TD') continue;
          const peers = components.filter((p) => p.parent === c.parent && Math.min(p.box.y + p.box.height, c.box.y + c.box.height) > Math.max(p.box.y, c.box.y));
          const total = peers.reduce((n, p) => n + p.box.width, 0);
          cell.style.width = `${100 * c.box.width / total}%`;
          cell.style.padding = '0';
          cell.style.verticalAlign = 'top';
          const table = cell.closest('table');
          if (table) { table.style.tableLayout = 'fixed'; table.style.width = '100%'; }
        }
      }, layout.components);
      const after = await measure();
      if (after.length < discrepancies.length && before === await page.locator('body').innerText()) {
        html = await page.locator('body').innerHTML();
        discrepancies = after;
        repaired = true;
      } else await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
    }
    const png = await page.screenshot({ path: screenshot });
    const a = await sharp(original).resize(128, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const b = await sharp(png).resize(128, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const pixelMeanAbsoluteError = a.reduce((n, x, i) => n + Math.abs(x - b[i]!), 0) / a.length / 255;
    return { html, discrepancies, pixelMeanAbsoluteError, repaired };
  } finally { await browser.close(); }
}
