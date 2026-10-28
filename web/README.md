# ImgtoHTML TypeScript app

The main app is a local Fastify server plus the existing Vite UI. Image decoding,
OCR and conversion run in Node. `src/core/` remains pure and browser-free; this
migration does not change its color, spacing, privacy or rendering behavior.

## Requirements and installation

- Node **20.19+ or 22.12+** (newer even-numbered releases are also supported), npm.
- Tesseract CLI with English (eng) data, available as tesseract on PATH.
  Ubuntu/WSL: `sudo apt-get install tesseract-ocr tesseract-ocr-eng`.
  macOS: `brew install tesseract`. Windows: install Tesseract and add it to PATH,
  or run the app in WSL.
- Python is unnecessary for this app.

From this directory:

    npm ci
    tesseract --version
    tesseract --list-langs

If the CLI is not installed, OCR falls back to Tesseract.js in a **Node worker**.
The worker, WASM engine and English trained data come from installed packages;
there are no runtime downloads, CDNs or external API calls. CLI errors such as
missing English data are reported rather than silently changing engines.
Only dependency installation needs network access.

## Commands

    npm run dev       # server :3000 + Vite :5173, watched together
    npm run build     # type-check, build dist/, bundle server into dist-server/
    npm start         # production server + built client on :3000
    npm test          # all Vitest tests; server OCR is mocked
    npm run typecheck # client/tests plus separate server/core check without DOM types
    npm run test:ocr  # optional real native and forced-fallback OCR integration check

Use **http://127.0.0.1:5173** during development and
**http://127.0.0.1:3000** after building. Both listeners are explicitly bound to
127.0.0.1; the application has no option to bind all network interfaces.
Vite proxies /api to port 3000. Start serves only the built client directory,
not source files. Keep node_modules alongside the builds: the server bundle
uses installed native/WASM dependencies. Ctrl+C stops the processes.

## Conversion API

`POST /api/convert` accepts multipart/form-data:

| Field | Meaning |
| --- | --- |
| image | One PNG, JPEG, GIF, WebP, BMP or TIFF file, at most 25 MiB |
| kind | terminal (default), code, interface or diagram |
| label | Optional accessible label; blank/whitespace means use the default |
| caption | Optional caption; blank/whitespace means use the default |
| transcript | Optional corrected text; nonblank text replaces OCR text |

Fields may follow the file in the multipart body. Image contents must decode
and match the filename extension; MIME headers alone are not trusted. Text
fields are limited to 1 MiB each, and decoded images to 40 million pixels.

Successful submission returns HTTP **202** with `{ "id": "..." }` and
`Location: /api/jobs/<id>`. Poll `GET /api/jobs/:id`:

    { "id": "...", "status": "queued", "progress": "Waiting for the text reader…" }

Status becomes running (with progress), then either completed with a
result, or failed with an error. A completed result contains:

- html, transcript, review, and the existing UI statistics.
- htmlFile, transcriptFile, reviewFile: objects with name, mime, content.
- preview: name, mime, content, including the comparison page HTML.
- imageDataUrl: a PNG of the decoded image, also usable for TIFF display.

For My screenshot.TIFF, file names are Media_My_screenshot.tiff.html,
My_screenshot_transcript.txt, My_screenshot_review.json, and
My_screenshot_preview.html. The browser downloads these files; the server
does not write output artifacts into out/.

Malformed files/forms return 400, oversized uploads/fields 413, non-multipart
requests 415, and a full queue 429. Unknown/expired jobs return 404. Errors are
JSON with an error string. API responses are not cached. Requests with remote
Host/Origin headers are rejected; no cross-origin access is enabled.

At most four conversions (including uploads) are admitted at once, and their
OCR passes run serially. Up to 20 finished results are retained for 30 minutes;
expiration is enforced when jobs are accessed or submitted. Restart clears all
jobs. Shutdown waits for admitted OCR work and closes the fallback worker.
Native OCR passes have a two-minute timeout and always remove temporary TSV
and character-box files.

## Structure and data flow

    src/main.ts + src/browser/api.ts
      -> multipart upload / job polling
    server/app.ts + server/jobs.ts
      -> server/image.ts: decode, orient, flatten, final GIF frame
      -> server/ocr/pipeline.ts: ink preprocessing, scaling, margin, panel rereading
      -> OcrEngine: native CLI (TSV + makebox) or local Tesseract.js
      -> src/core/convert.ts: unchanged layout, colors, privacy and Canvas HTML
      -> named output files + comparison page

OcrEngine.recognize receives a prepared PNG and its dimensions, returning
words with text, bounding boxes, confidence and block/paragraph/line IDs.
Both bundled engines also provide character boxes, preserving the existing
color logic. The native implementation launches Tesseract with spawn and an
argument array, never a shell command. Its TSV and bottom-origin character
boxes are normalized before the shared OCR pipeline maps them to screenshot
coordinates.

The pipeline preserves inkImage, scaling and the 8-pixel white margin. It
reads the whole image, segments it using the existing core, then rereads each
nonempty panel against that panel's background. Each panel keeps the reading
with the higher confidence × letter-count score. Sharp supplies server-side
resampling; exact OCR readings may differ from browser Canvas resampling or
between installed Tesseract versions/language datasets.

Sharp handles PNG/JPEG/GIF/WebP/TIFF decoding, GIF frame compositing, EXIF
rotation and PNG preview encoding. A local BMP decoder keeps ordinary Windows
BMP support on systems where libvips has no BMP loader. Transparent pixels
are flattened on white, as in the previous TypeScript app.

server/vision.ts defines VisionModel.analyze(image, regions) and region
suggestions (regionId, label, suggestedText, confidence). Its
NullVisionModel returns an empty list. It is not called by conversion. No
Ollama client or new region-by-region review workflow is implemented.

## Parity and tests

The unchanged core tests remain in place. Fastify injection tests run real
decoding/preprocessing/conversion with mocked OCR words; separate tests check
engine selection, TSV/character boxes and panel rereading.

| Required behavior | Regression coverage |
| --- | --- |
| Corrected transcript overrides text; OCR still supplies colors | server.test.ts, convert.test.ts |
| Home-path usernames and learned email identities are masked | server.test.ts, privacy.test.ts |
| GIF final frame and default caption | image-server.test.ts, server.test.ts |
| Blank label/caption mean not given | server.test.ts, convert.test.ts |
| Python review fields, including sanitized low-confidence words | server.test.ts |
| Comparison page embeds the original PNG and draft | server.test.ts, convert.test.ts |
| All four output filenames | server.test.ts, convert.test.ts |
| TIFF accepted and displayed as a PNG preview | image-server.test.ts, server.test.ts |
| Inline-only Canvas fragment and one div per line | server.test.ts, render.test.ts |

All requested parity cases are covered. The existing TypeScript differences
from Python remain intentional: per-word/character colors, interface-panel
rendering, icon filtering, downloads instead of automatic disk outputs, and
local OCR preprocessing/panel passes. OCR text is not guaranteed byte-for-byte
identical between engines. Comparison-page styles are separate from the
Canvas fragment; the original screenshot embedded there is not privacy-masked.


## Vision layout reconstruction

When Ollama is available, conversion now asks the existing Qwen3-VL model for a
whole-image application classification and component tree before rendering.
Components include sidebars, editors, tabs, breadcrumbs, code, menus, toolbars,
terminal panes and content containers. The model answers on Qwen3-VL's native
0–1000 grid, which is scaled to image pixels. Invalid IDs, cycles, missing
parents, out-of-bounds boxes and overlapping siblings are rejected. One bounded
model retry, told the first problem found, requests a corrected hierarchy.
Boundaries between stacked siblings (columns or rows: sidebar/editor, tab bar/
breadcrumb/code) move to the nearest strong pixel edge that cuts through no OCR
word, staying in order; contents stretch with them. Without such an edge the
model's geometry is kept.
Invalid or unavailable layouts retain the existing rendering path.

IDE, code-editor, website and desktop classifications select structural rendering
even when the submitted type was terminal. Terminal-only screenshots keep the
existing terminal renderer. Diagram mode, transcript overrides and disabling the
editor-window option retain their existing paths. Layout metadata appears in
`review.layout`. `review.layout_status` names the renderer that drew the HTML
(`layout`, `editor-window`, `code`, `transcript`, `panels` or `rows`), the reason
the layout wasn't used, and each model answer with why it was rejected.
`review.server_build` matches `GET /api/version`; `start.sh` restarts a running
server whose build differs from `dist-server/index.js`. No vision transcription becomes rendered text: masked OCR words
are assigned once to the smallest containing component; unmatched words are kept
in a trailing fallback block. Review alternatives and manual edits still work.

Column structure uses inline-styled tables; component contents use inline-styled
divs. Widths adapt to the host, with local horizontal scrolling on narrow screens.
There are no runtime scripts, remote resources or stylesheets in exported HTML.

For optional browser validation, install development dependencies and Chromium:

    npm ci
    npx playwright install chromium
    IMGTOHTML_VALIDATE_LAYOUT=1 npm start

Validation measures component boundaries in Chromium against source-coordinate
boxes and reports errors exceeding 8% of image width/height. It also records a
normalized pixel difference at 128 x 64 resolution. Pixel differences are diagnostic,
not an OCR correction signal. A bounded repair pass fixes distorted table column
widths and cell padding only when it reduces discrepancies and keeps rendered
text unchanged. Unresolved errors remain in `review.visual_validation`; missing
browser tooling is reported there without failing conversion. Validation is off
by default because starting Chromium adds latency and memory usage.

Run the deterministic VS Code browser regression with:

    npm run test:layout
    npm run test:layout -- --live

The first uses checked-in geometry annotations and the existing local screenshot
`fixtures/code/vscode-package-json.png`, runs real OCR, writes HTML/screenshot/report
to `eval-results/layout`, and verifies recovery from deliberately damaged columns.
The second exercises the installed Qwen model's layout detection. Screenshot
fixtures remain local under the repository's existing privacy policy. Unit tests
use synthetic OCR plus the geometry annotations and need neither Ollama nor Chromium.

Canvas checks use this project's approximate allowlist, not a live Canvas server.
Actual LMS sanitization still needs verification in the destination instance.
Approximate model boxes, OCR character errors, unsupported overlapping windows,
font metrics, missing icons and model misclassification can still reduce fidelity.
The browser repair pass handles column sizing, not arbitrary incorrect model trees.


### Component-specific reconstruction

Detected `code` components reuse the existing gutter cleanup, quote normalization,
JSON brace repair, language detection, and syntax highlighter. Their gutter width
is measured from OCR coordinates when available. Editor hints such as Debug and
text outside numbered code are kept, while cropped strings and commands are not
completed. Duplicate opening quotes before a nonempty JSON value are normalized
conservatively. The source OCR spans and transcript remain available unchanged for
review. `review.code` summarizes the first code component; `review.code_panels`
records each component's cleanup, including duplicate-quote corrections.
Syntax colors are the screenshot's own: each OCR row is highlighted to learn
which letters are keys, strings and so on, and each kind with at least six
measured letters takes their median color (`code_panels[].colors_measured`).
A letter's color takes its hue from all its ink pixels and its strength from
its core (the half farthest from the background), since smoothed screen text
has pale cores and colorful edges that the eye blends.
Kinds without enough letters keep VS Code Dark+.

When OCR was unsure of a word (below 95%) and the vision model read it with
only lookalike characters changed (I/T, I/l/1, O/0, comma/period, curly/straight
quotes, or one dropped period), the vision reading is used and listed in
`review.vision.corrected`. Any other disagreement stays a review suggestion.

Every component, including empty containers, gets its dominant background from
its source rectangle. UI font choice uses OCR symbol advances where enough are
available, otherwise word-width measurements. If evidence is insufficient it
falls back to a UI font for interface controls and monospace for terminals.
This is a heuristic, not font identification. Code remains monospace. Measurements
and removed chrome readings appear in `review.panel_features`.

Tabs, toolbars and menus split controls only at a large horizontal gap or a
measured background change. Multiword labels remain together when those signals
are absent. Each control uses its measured background in an inline-styled cell.
A narrow icon-noise rule suppresses short, low-confidence icon-like strings only
in upper-right sidebar/menu/toolbar chrome. Ordinary labels, filenames, numbers,
code and ambiguous text remain for review. Icons are not synthesized, with one
exception: in a sidebar where at least three rows start with a closed-arrow
glyph (">"), single arrow lookalikes that start a labelled row are tree arrows
and are drawn as › (closed) or ⌄ (open, read as "v" or "Y"); each is listed in
`panel_features[].arrows`.

A code line whose background differs from the panel's, measured across the
panel on its numbered row (the current line, a selection, a diff band), keeps
that background (`code.lines_highlighted`). This is skipped when the numbered
rows don't match the code lines one for one, or when most lines would differ.
