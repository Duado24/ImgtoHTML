# Prompt: progress bar, clearer review, responsive table-free output

You're working in the ImgtoHTML repo (TypeScript app in `web/`). Make the four
changes below. Run `cd web && npm test && npm run build && npm run eval` before
you finish, and update tests that assert the old behavior.

## Hard rules (non-negotiable)

1. **No tables in generated HTML.** No `<table>`, `<tr>`, `<td>`, not even with
   `role="presentation"`. Tables are not accessible, and students read this on
   phones and laptops, not only desktops.
2. **The output must be responsive.** It must read well from 320px to desktop
   width with no horizontal scrolling and nothing cut off.
3. **Canvas constraints still apply:** inline styles only, and only properties in
   `ALLOWED_CSS` in `web/src/core/canvas.ts`. Flex is allowed (`display:flex`,
   `flex-wrap`, `flex-basis`, `flex-grow`, `min-width`). **Grid, `gap` and media
   queries are not**, so responsiveness has to come from `flex-wrap` + `flex-basis`
   + `min-width`, not breakpoints. `checkCanvasSafe` must return no issues.

## 1. Generated HTML: remove tables, wrap code, columns that adapt

Today the output clips content and keeps the screenshot's pixel proportions.

Where the tables are:
- `web/src/core/editor-window.ts`: the whole editor window is a table (sidebar
  `<td style="width:28%">` + editor `<td>`), and every code line is a `<tr>` with a
  line-number `<td>` (lines ~95, 124–152).
- `web/src/core/vision-layout.ts` ~line 128: side-by-side components are a
  `table-layout:fixed` table, with each column `width:` set to its
  **pixel share of the screenshot**. That's why one column comes out slightly
  wider than the other instead of adapting.
- `web/src/core/convert.ts` ~lines 393–395 (highlighted code rows) and ~422–427
  (side-by-side panels): same pattern.

Where the clipping comes from:
- `web/src/core/render.ts:83`: `kind === "code"` uses `white-space:pre` +
  `overflow:hidden`, so long code lines are cut off.
- `editor-window.ts`: `white-space:pre` on code cells, `overflow:hidden` on the
  window, `white-space:nowrap;overflow:hidden` in the sidebar tree.
- `render.ts:175`: panels use `white-space:pre` + `overflow:hidden`.

What to do:
- Rebuild these as nested `<div>`s. Side-by-side columns become a
  `display:flex;flex-wrap:wrap` row. Each child gets `flex:1 1 <basis>px;min-width:0`
  with a sensible basis (around 260–320px), so columns share space **equally** when
  there's room and **stack** on narrow screens. Don't use the screenshot's pixel ratios as widths.
- Code lines: `white-space:pre-wrap;overflow-wrap:anywhere`, keeping indentation.
  Use a hanging indent so wrapped continuations are readable. `render.ts` already
  has a `WRAP` style for this; reuse it.
- Line numbers: a flex row per line, with a fixed-width number
  (`flex:0 0 <n>ch`, `aria-hidden="true"`) and the code (`flex:1 1 auto;min-width:0`).
  Long lines must wrap next to their number.
- Remove every `overflow:hidden` that clips text. Keep it only where it trims decoration.
- Don't use `min-height` in px taken from the screenshot when it forces tall empty boxes on phones.
- Keep accessibility: `role="figure"` + `aria-label` on the wrapper,
  decorative chrome `aria-hidden`, and real text as text.
- Tests: replace assertions that expect tables (`tests/editor-window.test.ts`
  lines 62–87, `tests/vision-layout.test.ts` ~54–58) with:
  - the output contains no `<table`, `<tr` or `<td`;
  - no element combines `white-space:pre` with `overflow:hidden`;
  - side-by-side columns use `flex-wrap:wrap` and equal flex bases;
  - `checkCanvasSafe` returns `[]`.
- Also update the comparison page in `convert.ts` (~line 800). It's a local file,
  so grid and media queries are fine there, but it must not clip the reconstruction either.

## 2. Progress bar instead of the loading animation

Today `web/src/style.css:141–149` shows an indeterminate sliding bar, a blinking
cursor and a scanning line (`.scan-busy`, ~line 204). The server only reports a
progress **text** (`web/server/jobs.ts`, `progress("Reading text…")` etc.).

- Add a numeric progress to the job: `progress: { percent: number; step: string }`
  in `web/src/shared/api.ts`. Set it in `jobs.ts` from the real stages:
  queued → reading text (use Tesseract's own progress callback in
  `recognizeWords` for the 0–60% range) → layout detection → vision model →
  rendering → validating → done. Re-reading a region gets its own 0–100.
- In `web/index.html` replace `.progress` with a native
  `<progress max="100" value="…">` (or `role="progressbar"` with
  `aria-valuenow`/`aria-valuemin`/`aria-valuemax`). Show the label next to it:
  `"Reading text… 42%"`.
- Remove the sliding bar, the blinking cursor and `.scan-busy`. Keep
  `prefers-reduced-motion` respected.
- The bar must never go backwards. When a step's duration is unknown (vision
  model), move slowly within that step's range rather than jumping.

## 3. Make the review understandable

Today the results show "Low confidence: **27**" as a big red number. Below it are
review cards titled like `r3 · code · 64% sure` that list flagged words with
technical reasons. Problems:

- **The 27 never changes.** It's `uncertain.length` from OCR
  (`web/src/core/convert.ts:594`), counted once before vision corrections. It
  doesn't drop when you approve, correct or skip anything, and it isn't the same
  thing as the review cards. On the VS Code sample it says 27 while the text is
  99.8% correct, so it reads as alarming and meaningless.
- Region IDs (`r3`), roles and "% sure" mean nothing to a teacher.
- It's unclear what to do, what's left, and when you're done.

What to do:
- Remove the "Low confidence" stat. Replace it with **review progress tied to the
  cards**: "3 of 5 checked" plus a small bar, updating live as cards are approved,
  corrected or skipped. Use `reviewCounts` in `web/src/browser/review-status.ts`.
- Each card in plain language:
  - Title: where it is ("Code, lines 4–9", "Left sidebar", "Title bar"), not `r3 · code`.
  - Show a crop of the original screenshot for that area beside the current text,
    so the comparison is visual.
  - Each flagged word: "We read **`Nod`** here. Is that right?" with the
    alternatives as buttons, plus an edit field. No raw flag `detail` strings.
    Map them to short human reasons ("looks like a lookalike letter", "text was
    faint") or drop them.
  - Actions: **Correct**, **Fix it** (edit), **Skip**. Rename "Doesn't look
    right — focus here" to "Read this part again".
- Order cards top to bottom as they appear in the screenshot. Collapse finished
  cards to one line ("✓ Code, lines 4–9"), and move focus to the next open card.
- One clear end state: "All checked — ready to copy into Canvas".
- Keep "Skip all" but confirm it ("Skip 5 checks? Their text stays unverified.").
- Keep it keyboard and screen-reader friendly (headings, `aria-live` for the
  progress, focus management).

## Done means

- No `<table` anywhere in generated HTML, and tests prove it.
- At 320px, 768px and 1280px viewport widths, the VS Code sample
  (`web/fixtures/code/vscode-package-json.png`) shows every character with no
  horizontal scroll, and its columns stack on the phone width. Check this in a real
  browser, not just tests, and show screenshots.
- The progress bar shows real percentages and step names during a conversion.
- The review shows "N of M checked", plain-language cards with a crop of the
  screenshot, and the number changes as you act.
- `npm test`, `npm run build` and `npm run eval` all pass. If eval scores change,
  explain why before saving a new baseline.
