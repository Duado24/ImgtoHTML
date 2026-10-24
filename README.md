# AutoCanv — Screenshot to Canvas HTML

## Purpose

Convert screenshots into local, accessible HTML drafts for Canvas LMS. The original screenshot and resulting HTML must be compared before publication.

## Files

| File | Purpose |
|---|---|
| `screenshot_to_canvas.py` | Main OCR and HTML generation script |
| `requirements.txt` | Python dependencies |
| `RULES.md` | Project rules every change and output must follow |
| `README.md` | Setup and usage |
| `FAQ.md` | Current features and limitations |

## Installation

Install Python 3 and Tesseract OCR, then run:

```bash
python -m pip install -r requirements.txt
```

## Usage

Terminal screenshot:

```bash
python screenshot_to_canvas.py example.gif --type terminal
```

Code screenshot:

```bash
python screenshot_to_canvas.py example.png --type code
```

Software interface:

```bash
python screenshot_to_canvas.py application.png --type interface
```

Diagram text:

```bash
python screenshot_to_canvas.py diagram.png --type diagram
```

Provide a meaningful description:

```bash
python screenshot_to_canvas.py example.gif --label "Terminal showing output from a Python program"
```

Use a corrected transcript:

```bash
python screenshot_to_canvas.py example.gif --transcript out/example_transcript.txt
```

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

Run `python -m unittest -v test_spacing.py` to execute the synthetic spacing tests.

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
  preview.html
```

Only the `Media_*.html` fragment is intended for Canvas. The preview uses a style block for local comparison only.

