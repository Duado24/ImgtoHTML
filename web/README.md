# ImgtoHTML web app

A static page (Vite + TypeScript, no server) that turns an AI's screenshot
report into Canvas HTML.

```text
src/main.ts               the page: paste a report, checklist, preview, downloads
src/browser/review-status.ts   checklist counts and wording
src/core/report.ts        the report format (v1) and its checker
src/core/prompt.ts        the AI instructions that produce reports
src/core/convert.ts       report → Canvas HTML, transcript, checklist items
src/core/render.ts        terminal and plain code box
src/core/editor-window.ts VS Code-style window: explorer, tabs, line numbers
src/core/panels.ts        app and website screenshots as nested wrapping panels
src/core/diagram.ts       diagrams as a written description
src/core/code.ts          language detection and syntax colors (highlight.js)
src/core/theme.ts         the course themes (VS Code Dark+)
src/core/canvas.ts        what Canvas would strip (tables count as errors)
src/core/privacy.ts       masks user names in home-folder paths and emails
scripts/eval.ts           scores reports against known-correct text
```

## The report

One JSON object, version 1. `src/core/report.ts` documents every field;
`src/core/prompt.ts` tells the AI how to fill them, and a test checks that its
example passes the checker.

- `kind`: `terminal`, `code`, `interface` or `diagram`; `application`: `ide`,
  `code-editor`, `terminal`, `website`, `desktop` or `other`.
- `regions`: the screenshot's parts in reading order, each with a `type`
  (sidebar, tabs, breadcrumbs, code, terminal, toolbar, menu, content…), an
  optional `parent`, a `box` on a 0–1000 grid, optional `background` and
  `color`, and its exact `lines`. Code may give `first_line`.
- `cut_off_lines` and `unsure_words` per region become the checklist.
- `diagram`: a summary, nodes and edges, for diagrams.

The checker accepts the JSON inside a ```` ```json ```` fence, lists every
problem at once, and warns about fields it doesn't know.

## How each kind is drawn

| Kind | Drawn as |
| --- | --- |
| terminal | the course terminal theme; prompts green, error lines red |
| code | syntax-colored code; with explorer, tabs or breadcrumbs, a VS Code window (narrow explorer, wide editor, line numbers from `first_line`) |
| interface | nested panels in the report's colors; side-by-side parts wrap on phones |
| diagram | a written description: summary, parts, connections |

Every kind: no tables or `<pre>`, inline styles, `white-space:pre-wrap` so
nothing is clipped, 0.75rem rounded boxes, text at 4.5:1 or better, and a
`role="figure"` with an `aria-label`. Cut-off lines end in `…`; text the AI
didn't see is never invented.

## Tests and evaluation

    npm test              # unit tests + a Playwright test of the page at desktop and phone width
    npm run eval          # score reports in fixtures/ against their .txt (see fixtures/README.md)

`npm run build` adds a Content-Security-Policy `<meta>` to the page: scripts
and styles only from itself, and `connect-src 'none'`, so the page can't send
anything anywhere.
