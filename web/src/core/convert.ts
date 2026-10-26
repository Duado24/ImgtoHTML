/** Screenshot → Canvas HTML draft. Pure: takes decoded pixels and OCR
 *  words, returns the files to offer for download. The browser parts
 *  (decoding the image, running OCR) live in src/browser/. */

import { blackOrWhite, colorsFromWords, contrast, fixContrast, rgbHex } from "./colors";
import { layoutWords, type UncertainWord } from "./layout";
import { sanitizeLines, sanitizeText } from "./privacy";
import { render } from "./render";
import type { Kind, OcrWord, Pixels } from "./types";

export interface ConvertInput {
  /** Original file name, e.g. "Screenshot 2026-10-23.png". */
  fileName: string;
  pixels: Pixels;
  words: readonly OcrWord[];
  /** True for a GIF with more than one frame (pixels are the last frame). */
  animated: boolean;
  kind: Kind;
  label?: string | null;
  caption?: string | null;
  /** Corrected transcript; replaces the OCR text when given. */
  transcript?: string | null;
}

export interface ColorChange {
  element: "text";
  original: string;
  adjusted: string;
  contrast_after: number;
}

/** Same fields as the Python _review.json, plus the colors actually used. */
export interface Review {
  type: Kind;
  low_confidence_words: UncertainWord[];
  original_colors: { background: string; foreground: string };
  rendered_colors: { background: string; foreground: string };
  contrast_changes: ColorChange[];
  second_color_ratio: number;
  check_colors_by_hand: boolean;
  contrast_ratio: number;
  privacy: {
    home_path_masking: boolean;
    learned_email_identity_masking: boolean;
    generic_email_replacement: boolean;
    manual_review_required: boolean;
  };
  limitations: string[];
}

export interface OutputFile {
  name: string;
  mime: string;
  content: string;
}

export interface ConvertResult {
  html: string;
  transcript: string;
  review: Review;
  lineCount: number;
  lowConfidenceCount: number;
  /** Base for the output file names, e.g. "Screenshot_2026-10-23". */
  stem: string;
  htmlFile: OutputFile;
  transcriptFile: OutputFile;
  reviewFile: OutputFile;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** "Photo 1.PNG" → { stem: "Photo 1", suffix: ".png" } (like pathlib). */
export function splitName(fileName: string): { stem: string; suffix: string } {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { stem: base, suffix: "" };
  return { stem: base.slice(0, dot), suffix: base.slice(dot).toLowerCase() };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

export function convert(input: ConvertInput): ConvertResult {
  const { kind, pixels, animated } = input;

  // Empty text boxes send "" rather than nothing: blank means "not given".
  let label = input.label?.trim() || null;
  let caption = input.caption?.trim() || null;
  const transcript = input.transcript?.trim() ? input.transcript.replace(/\r\n/g, "\n") : null;

  // OCR always runs, even with a corrected transcript: its word boxes
  // are where the text color is measured.
  const ocr = layoutWords(input.words);

  const rawLines = transcript !== null ? transcript.split("\n") : ocr.lines;
  const rawUncertain = transcript !== null ? [] : ocr.uncertain;

  // Privacy
  const { lines, names } = sanitizeLines(rawLines);
  const uncertain = rawUncertain.map((w) => ({ ...w, text: sanitizeText(w.text, names) }));

  // Colors: the box background is pure black or white; the text keeps
  // the screenshot's color, made lighter or darker only if needed for contrast.
  const measured = colorsFromWords(pixels, ocr.boxes);
  const background = blackOrWhite(measured.background);
  const foreground = fixContrast(measured.foreground, background);

  const colorChanges: ColorChange[] = [];
  if (rgbHex(foreground) !== rgbHex(measured.foreground)) {
    colorChanges.push({
      element: "text",
      original: rgbHex(measured.foreground),
      adjusted: rgbHex(foreground),
      contrast_after: round2(contrast(foreground, background)),
    });
  }

  // Accessibility text
  if (animated && caption === null) {
    caption = "Animated in the original. This reconstruction shows the final frame.";
  }
  const { stem: rawStem, suffix } = splitName(input.fileName);
  label ??= `${capitalize(kind)} screenshot showing the content of ${rawStem}`;

  const html = render(lines, kind, label, background, foreground, caption);

  const review: Review = {
    type: kind,
    low_confidence_words: uncertain,
    original_colors: {
      background: rgbHex(measured.background),
      foreground: rgbHex(measured.foreground),
    },
    rendered_colors: {
      background: rgbHex(background),
      foreground: rgbHex(foreground),
    },
    contrast_changes: colorChanges,
    second_color_ratio: round2(measured.secondaryRatio),
    check_colors_by_hand: kind === "code" || measured.secondaryRatio >= 0.3,
    contrast_ratio: round2(contrast(foreground, background)),
    privacy: {
      home_path_masking: true,
      learned_email_identity_masking: true,
      generic_email_replacement: false,
      manual_review_required: true,
    },
    limitations: [
      "OCR requires character-by-character review",
      "Whitespace reconstruction is approximate",
      "Only one foreground color is estimated",
      "Text color is measured inside OCR word boxes; multi-colored text uses the most common color",
      "Box background is pure black or white, chosen from the screenshot's background",
      "Diagram geometry is not reconstructed",
      "UI controls are not reconstructed",
      "Animated GIFs use their final frame",
      "Username masking is pattern-based and incomplete",
    ],
  };

  const stem = rawStem.replace(/[^\p{L}\p{N}_.-]+/gu, "_");
  const transcriptText = lines.join("\n");

  return {
    html,
    transcript: transcriptText,
    review,
    lineCount: lines.length,
    lowConfidenceCount: uncertain.length,
    stem,
    htmlFile: { name: `Media_${stem}${suffix}.html`, mime: "text/html", content: html },
    transcriptFile: { name: `${stem}_transcript.txt`, mime: "text/plain", content: transcriptText },
    reviewFile: {
      name: `${stem}_review.json`,
      mime: "application/json",
      content: JSON.stringify(review, null, 2),
    },
  };
}

// ------------------------------------------------------------
// What the page shows (was summarize() in web.py)
// ------------------------------------------------------------

export interface Issue {
  level: "error" | "warn" | "info";
  text: string;
  words?: string[];
}

export function issuesFor(review: Review): Issue[] {
  const issues: Issue[] = [];
  const words = review.low_confidence_words.map((w) => w.text);

  if (words.length) {
    issues.push({ level: "error", text: `${words.length} low-confidence words — check these first.`, words });
  }
  if (review.check_colors_by_hand) {
    issues.push({
      level: "warn",
      text: "Several text colors in the original; the HTML uses one. Check colors by hand.",
    });
  }
  const change = review.contrast_changes[0];
  if (change) {
    issues.push({
      level: "info",
      text: `Text color adjusted from ${change.original} to ${change.adjusted} for contrast.`,
    });
  }
  if (review.rendered_colors.background !== review.original_colors.background) {
    issues.push({
      level: "info",
      text: `Background ${review.original_colors.background} shown as ${review.rendered_colors.background}.`,
    });
  }
  return issues;
}

/** Local comparison page: original screenshot beside the HTML draft.
 *  The screenshot appears here only, never in the Canvas fragment. */
export function previewPage(result: ConvertResult, pngDataUrl: string): OutputFile {
  const content = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ImgtoHTML comparison</title>
<style>
body { font-family:Arial,sans-serif; margin:12px; background:#fff; color:#000; }
main { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
section { min-width:0; }
img { max-width:100%; height:auto; }
@media(max-width:700px) { main { grid-template-columns:1fr; } }
</style>
</head>
<body>
<h1>Screenshot versus HTML draft</h1>
<main>
<section>
    <h2>Original</h2>
    <img alt="Original screenshot for comparison" src="${pngDataUrl}">
</section>
<section>
    <h2>Reconstruction</h2>
    ${result.html}
</section>
</main>
</body>
</html>`;
  return { name: `${result.stem}_preview.html`, mime: "text/html", content };
}
