import sharp from "sharp";
import type { Page } from "@playwright/test";
import type { VisionLayout } from "../src/core/vision-layout";

export const RESPONSIVE_WIDTHS = [375, 768, 1280] as const;
export interface ResponsiveViewportReport {
  width: number;
  horizontalOverflow: number;
  clippedText: string[];
}
export interface VisualReport {
  discrepancies: { component: string; error: number }[];
  pixelMeanAbsoluteError: number;
  repaired: boolean;
  html: string;
  responsive: ResponsiveViewportReport[];
}

/** Measure the rendered glyphs as well as scrollWidth. An overflow:hidden
 * ancestor can hide text while the document itself still fits the viewport. */
async function measureResponsive(page: Page): Promise<ResponsiveViewportReport> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const tolerance = 1;
    const clippedText = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const parent = text.parentElement;
      if (!parent || !text.textContent?.trim() || /^(SCRIPT|STYLE)$/.test(parent.tagName)) continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const range = document.createRange();
      // pre-wrap lets trailing spaces hang outside the line box. Measure
      // actual words so those invisible spaces cannot mask a good wrap.
      const rects = [...text.textContent.matchAll(/\S+/g)].flatMap((word) => {
        range.setStart(text, word.index);
        range.setEnd(text, word.index + word[0].length);
        return [...range.getClientRects()].filter((r) => r.width && r.height);
      });
      let clipped = rects.some((r) => r.left < -tolerance || r.right > width + tolerance);
      for (let el: Element | null = parent; el && !clipped; el = el.parentElement) {
        const css = getComputedStyle(el);
        const clipX = /^(hidden|clip|auto|scroll)$/.test(css.overflowX);
        const clipY = /^(hidden|clip)$/.test(css.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = el.getBoundingClientRect();
        // Borders are outside the clipping area; glyph bearings may extend a
        // fraction of a pixel, so allow one pixel of rounding tolerance.
        const left = bounds.left + el.clientLeft, top = bounds.top + el.clientTop;
        const right = left + el.clientWidth, bottom = top + el.clientHeight;
        clipped = rects.some((r) => (clipX && (r.left < left - tolerance || r.right > right + tolerance)) ||
          (clipY && (r.top < top - tolerance || r.bottom > bottom + tolerance)));
      }
      if (clipped) clippedText.add(text.textContent.trim().slice(0, 160));
    }
    return { width, horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - width), clippedText: [...clippedText] };
  });
}

async function checkResponsive(page: Page, widths: readonly number[]): Promise<ResponsiveViewportReport[]> {
  const reports: ResponsiveViewportReport[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    reports.push(await measureResponsive(page));
  }
  return reports;
}

/** Uses the same script-free fragment and host styles as visual validation. */
export async function validateResponsive(html: string, widths: readonly number[] = RESPONSIVE_WIDTHS): Promise<ResponsiveViewportReport[]> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
    return await checkResponsive(page, widths);
  } finally { await browser.close(); }
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
      // Repair flex proportions / padding altered by inherited host styling.
      // Only inline structural CSS is changed; text nodes remain untouched.
      const before = await page.locator('body').innerText();
      await page.evaluate((components) => {
        for (const c of components) {
          const el = document.getElementById(`layout-${c.id}`);
          const cell = el?.parentElement;
          if (!cell || cell.parentElement?.style.display !== 'flex') continue;
          cell.style.flex = c.type === 'sidebar' ? '0 1 150px' : c.type === 'editor' ? '1 1 520px' : `1 1 ${Math.round(c.box.width)}px`;
          cell.style.minWidth = c.type === 'sidebar' ? '135px' : c.type === 'editor' ? '280px' : '0';
          cell.style.maxWidth = '100%';
          cell.style.boxSizing = 'border-box';
          cell.style.padding = '0';
        }
      }, layout.components);
      const after = await measure();
      if (after.reduce((sum, item) => sum + item.error, 0) < discrepancies.reduce((sum, item) => sum + item.error, 0) && before === await page.locator('body').innerText()) {
        html = await page.locator('body').innerHTML();
        discrepancies = after;
        repaired = true;
      } else await page.setContent(`<html><body style="margin:0">${html}</body></html>`);
    }
    const png = await page.screenshot({ path: screenshot });
    const a = await sharp(original).resize(128, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const b = await sharp(png).resize(128, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const pixelMeanAbsoluteError = a.reduce((n, x, i) => n + Math.abs(x - b[i]!), 0) / a.length / 255;
    const responsive = await checkResponsive(page, RESPONSIVE_WIDTHS);
    for (const report of responsive) {
      if (report.horizontalOverflow || report.clippedText.length) discrepancies.push({
        component: `viewport-${report.width}`,
        error: Math.max(report.horizontalOverflow / report.width, report.clippedText.length ? 1 : 0),
      });
    }
    return { html, discrepancies, pixelMeanAbsoluteError, repaired, responsive };
  } finally { await browser.close(); }
}
