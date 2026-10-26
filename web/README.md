# ImgtoHTML web (v2.0)

The screenshot-to-Canvas converter as one web page, in TypeScript. People
using it install nothing: they open the page, drop in a screenshot, and copy
or download the result.

**Everything runs in the visitor's browser.** The OCR engine (Tesseract.js),
its English language data and the converter are all served from the tool's
own folder. No screenshot or text is sent anywhere, and nothing is loaded
from a CDN.

## For people using it

1. Open the page.
2. Drop a screenshot or GIF (PNG, JPG, GIF, WEBP, BMP; up to 25 MB).
3. Pick the type, write a one-sentence screen-reader label, press **Convert**.
4. Compare the original with the draft, fix the transcript if needed, then
   **Copy HTML** into the Canvas HTML editor (`</>`).

The first conversion takes a few seconds while the text reader loads (about
15 MB, once per visit). Later ones are quick.

## For whoever maintains it

Needs Node.js 20 or newer.

```bash
npm install        # also copies the OCR files into public/ocr/
npm test           # unit tests
npm run dev        # local development page
npm run build      # site in dist/
npm run preview    # serve dist/ locally to check the build
```

### Sharing it

Put the whole `dist/` folder on any web server: a course or department
server, GitHub Pages, or similar. Paths are relative, so any address works.

Opening `dist/index.html` straight from disk (`file://`) does **not** work:
browsers block the OCR worker there. It must be served, even locally
(`npm run preview`).

## Layout

```text
src/core/      Converter, no browser APIs (tested with Vitest)
  colors.ts      background/text color, contrast fix, black/white box
  layout.ts      OCR words → lines with spaces, indents, blank lines
  privacy.ts     username masking
  render.ts      Canvas HTML fragment
  convert.ts     the whole conversion + review report + comparison page
src/browser/   Image decoding (GIF last frame) and Tesseract.js
src/main.ts    The page
tests/         Unit tests
scripts/       Copies the OCR files out of node_modules
```

## Changes from the Python version (v1.2.6)

- Runs in the browser; files are downloaded instead of written to `out/`.
- The box background is always **pure black or pure white**, whichever is
  closer to the screenshot's background. The text color is still measured
  from the screenshot and only adjusted if contrast is below 4.5:1. The
  review JSON lists both the original and the rendered colors.
- OCR is Tesseract.js (same engine, compiled for the browser). Results can
  differ slightly from the Python version's; check them the same way.
- TIFF is not accepted (most browsers can't open it).
- Spacing, privacy masking and HTML output follow the Python rules exactly,
  including Python's rounding.
