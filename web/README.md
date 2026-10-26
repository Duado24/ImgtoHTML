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

## How a screenshot is read

1. **OCR preprocessing** (`core/preprocess.ts`): each pixel becomes "how
   different is it from the background", so any text color on any
   background turns into dark print on white, then the image is enlarged
   3×. Tesseract is trained on print; small light-on-dark text was the main
   cause of misreads.
2. **Panels** (`core/regions.ts`): thin separator lines that run the full
   length of an area (sidebar border, tab bar border, terminal border) split
   the screenshot into panels. Then each panel is read again on its own,
   and each panel keeps whichever reading is more confident.
3. **Colors** (`core/paint.ts`): background per panel, highlights per word
   (selected file, active tab), and text color per word and per code token
   (`print`, `(`, `"Hello"`), measured from the pixels. Thin letters are
   corrected for blending, near-grays become true grays, and every color is
   checked for 4.5:1 contrast against what it sits on.
4. **HTML** (`core/render.ts`): type **UI** rebuilds the panels as nested
   boxes (side-by-side panels wrap under each other on phones); other types
   give one box. Inline styles only, no `<pre>`, one `<div>` per line.

## Changes from the Python version (v1.2.6)

- Runs in the browser; files are downloaded instead of written to `out/`.
- OCR preprocessing and a second, per-panel OCR pass (see above).
- Type UI rebuilds application panels; all types keep text colors per word
  and code token (Python used one color).
- Icons (◆ ⊘ ⌄) can't be reconstructed. OCR reads them as stray characters
  like `¢` or `~~`; those are left out and listed in the review.
- The page itself is solid black (dark mode) or solid white (light mode),
  following the computer's setting until the button is used.
- OCR is Tesseract.js (same engine, compiled for the browser). Results can
  differ slightly from the Python version's; check them the same way.
- TIFF is not accepted (most browsers can't open it).
- Spacing and privacy masking follow the Python rules, including Python's
  rounding.
