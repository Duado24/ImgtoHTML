# AutoCanv — Screenshot to Canvas HTML

## Purpose

Convert screenshots into local, accessible HTML drafts for Canvas LMS. The original screenshot and resulting HTML must be compared before publication.

## Web version (v2.0)

The `web/` folder holds the TypeScript version: one web page that runs
entirely in the browser, so colleagues need to install nothing. See
[web/README.md](web/README.md). The Python version below still works.

## Project layout

```text
imgtohtml/   Application package: converter, desktop UI, and review summary
web/         TypeScript browser version (v2.0)
tests/       Unit tests
docs/        FAQ and project documentation
README.md    Setup and usage
requirements.txt
```

## Installation

Install Python 3 and Tesseract OCR, then run:

```bash
python -m pip install -r requirements.txt
```

## Usage

Run the command-line converter with:

```bash
python -m imgtohtml.screenshot_to_canvas example.gif --type terminal
```

Launch the desktop interface with:

```bash
python -m imgtohtml.ui
```

The converter also supports `code`, `interface`, and `diagram` types:

```bash
python -m imgtohtml.screenshot_to_canvas example.png --type code
```

Provide a meaningful description:

```bash
python -m imgtohtml.screenshot_to_canvas example.gif --label "Terminal showing output from a Python program"
```

Use a corrected transcript:

```bash
python -m imgtohtml.screenshot_to_canvas example.gif --transcript out/example_transcript.txt
```

## Tests

Run the unit test suite from the project root:

```bash
python -m unittest discover -v
```

See [docs/FAQ.md](docs/FAQ.md) for feature and limitation details.

## Version 1.1 changes

- Estimates original foreground and background colors from screenshot pixels.
- Adjusts estimated foreground lightness if contrast is below 4.5:1.
- Logs color adjustments in the JSON review report.
- Estimates blank lines and indentation from OCR coordinates.
- Masks common usernames in paths and email-like identities.
- Removes automatically inserted visible headings.
- Adds a caption when an animated GIF is processed.
- Keeps long code lines inside a horizontally scrollable code panel.
- Preserves source extensions in generated HTML filenames.
- Produces a responsive comparison preview.

## Version 1.2.1 — OCR spacing

Updated word-spacing reconstruction to measure the horizontal distance between consecutive OCR bounding boxes.

- Character width is estimated primarily from longer alphanumeric words.
- Gaps smaller than 2.5 estimated character widths produce one space.
- Larger gaps retain their approximate spacing.
- Leading indentation continues to be inferred from OCR coordinates.
- No changes to command-line options, privacy rules, color detection, or HTML rendering.

The synthetic spacing tests are included in the full test suite above.

**Limitation:** OCR spacing remains an estimate. Exact preservation of source characters and whitespace requires comparison against the screenshot.

## Important limitations

- OCR cannot guarantee exact text or whitespace.
- Username sanitization does not detect every identity format.
- Color detection estimates one foreground color. It does not preserve multicolored syntax highlighting.
- Diagram structures and software controls are not reconstructed.
- GIF processing uses the final frame only.
- A local preview does not establish actual Canvas compatibility.
- Regression against approved examples must be completed before release.

## Output

For `example.gif`, the output directory includes:

```text
out/
  Media_example.gif.html
  example_transcript.txt
  example_review.json
  example_preview.html
```

Only the `Media_*.html` fragment is intended for Canvas. The preview uses a style block for local comparison only.
