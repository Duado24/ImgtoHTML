/** Screenshot → Canvas HTML draft. Pure: takes decoded pixels and OCR
 *  words, returns the files to offer for download. The browser parts
 *  (decoding the image, running OCR) live in src/browser/. */

import { checkCanvasSafe, type CanvasIssue } from "./canvas";
import { colorsFromWords, contrast, fixContrast, rgbHex, xHeight } from "./colors";
import { layoutWords, type UncertainWord } from "./layout";
import { colorsUsed, mainColor, measureLooks, paintLines, plainLines, type PaintedLine, type WordLook } from "./paint";
import { learnedUsernames, sanitizeLines, sanitizeText } from "./privacy";
import { segment, type Leaf, type Region } from "./regions";
import { render, renderPanels, type PaintedLeaf } from "./render";
import { isIconNoise, type Kind, type OcrWord, type Pixels } from "./types";
import { middle } from "./pymath";

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

/** Same fields as the Python _review.json, plus what the HTML uses. */
export interface Review {
  type: Kind;
  low_confidence_words: UncertainWord[];
  original_colors: { background: string; foreground: string };
  contrast_changes: ColorChange[];
  /** The most used text color in the HTML. */
  text_color: string;
  /** Every text color in the HTML (measured per word and code token). */
  colors_used: string[];
  /** Number of panels rebuilt (interface type), 1 otherwise. */
  panels: number;
  /** Short letterless OCR results left out as icons (e.g. "~~", "¢"). */
  icons_removed: string[];
  second_color_ratio: number;
  check_colors_by_hand: boolean;
  contrast_ratio: number;
  /** What Canvas's HTML editor may strip or break (see canvas.ts). */
  canvas_issues: CanvasIssue[];
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
  /** Panels found in the screenshot, whatever type was chosen. */
  panelsFound: number;
  /** True when a corrected transcript was used (one color, no panels). */
  fromTranscript: boolean;
  /** Base for the output file names, e.g. "Screenshot_2026-10-23". */
  stem: string;
  htmlFile: OutputFile;
  transcriptFile: OutputFile;
  reviewFile: OutputFile;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** "Photo 1.PNG" → { stem: "Photo 1", suffix: ".png" } (like pathlib). */
export function splitName(fileName: string): { stem: string; suffix: string } {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { stem: base, suffix: "" };
  return { stem: base.slice(0, dot), suffix: base.slice(dot).toLowerCase() };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

const leaves = (r: Region): Leaf[] => (r.kind === "leaf" ? [r] : r.children.flatMap(leaves));

/** Text size and padding of one panel, from where its words sit. */
function paintLeaf(pixels: Pixels, leaf: Leaf, looks: ReadonlyMap<OcrWord, WordLook>): PaintedLeaf {
  const { rows } = layoutWords(leaf.words);
  const lines = paintLines(rows, leaf.background, looks);
  const { box, words } = leaf;
  if (words.length === 0) return { lines, fontSize: 12, padding: { top: 0, right: 0, bottom: 0, left: 0 } };

  // Text size from the height of the small letters (a, e, o…), measured in
  // the pixels: about 0.53 of the font size in common UI and code fonts.
  const real = words.filter((w) => /[\p{L}\p{N}]{3}/u.test(w.text));
  const heights = (real.length ? real : words)
    .map((w) => xHeight(pixels, w, looks.get(w)?.background ?? leaf.background))
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const height = heights.length ? middle(heights) : 6.4;
  const top = Math.min(...words.map((w) => w.y)) - box.y;
  const left = Math.min(...words.map((w) => w.x)) - box.x;
  const bottom = box.y + box.height - Math.max(...words.map((w) => w.y + w.height));
  return {
    lines,
    fontSize: clamp(height / 0.53, 10, 16),
    padding: { top: clamp(top - 2, 2, 24), right: 8, bottom: clamp(bottom - 2, 2, 24), left: clamp(left, 4, 24) },
  };
}

export function convert(input: ConvertInput): ConvertResult {
  const { kind, pixels, animated } = input;

  // Empty text boxes send "" rather than nothing: blank means "not given".
  let label = input.label?.trim() || null;
  let caption = input.caption?.trim() || null;
  const transcript = input.transcript?.trim() ? input.transcript.replace(/\r\n/g, "\n") : null;

  // Privacy first, word by word, so masked text keeps its place and color.
  // (Paths and email addresses never contain spaces, so they are always
  // inside one OCR word.)
  const names = learnedUsernames(input.words.map((w) => w.text));
  const all = input.words.map((w) => ({ ...w, text: sanitizeText(w.text.trim(), names) }));
  // Icons can't be reconstructed; left in, they'd show as stray characters.
  // Also: lone punctuation far from any other text on its line ("]" at a
  // window edge) is window chrome, not content.
  const lonely = (w: OcrWord) =>
    [...w.text].length <= 2 &&
    !/[\p{L}\p{N}]/u.test(w.text) &&
    !all.some(
      (o) => o !== w && Math.abs(o.y - w.y) < w.height && Math.abs(o.x + o.width / 2 - (w.x + w.width / 2)) < 200,
    );
  const icon = (w: OcrWord) => isIconNoise(w) || lonely(w);
  const icons = all.filter(icon);
  const words = all.filter((w) => !icon(w));
  const looks = measureLooks(pixels, words);

  // OCR always runs, even with a corrected transcript: its word boxes
  // are where colors are measured.
  const ocr = layoutWords(words);
  const measured = colorsFromWords(pixels, ocr.boxes);
  const background = measured.background;
  const foreground = fixContrast(measured.foreground, background);
  const tree = segment(pixels, words);
  const panelsFound = leaves(tree).length;

  // Accessibility text
  if (animated && caption === null) {
    caption = "Animated in the original. This reconstruction shows the final frame.";
  }
  const { stem: rawStem, suffix } = splitName(input.fileName);
  label ??= `${capitalize(kind)} screenshot showing the content of ${rawStem}`;

  let html: string;
  let painted: PaintedLine[];
  let textLines: string[];
  let uncertain: UncertainWord[];
  let panels = 1;

  if (transcript !== null) {
    // Corrected text has no positions, so: one color, one box.
    textLines = sanitizeLines(transcript.split("\n")).lines;
    uncertain = [];
    painted = plainLines(textLines);
    html = render(painted, kind, label, background, foreground, caption);
  } else if (kind === "interface" && tree.kind === "split") {
    textLines = ocr.lines;
    uncertain = ocr.uncertain;
    painted = [];
    html = renderPanels(
      tree,
      (leaf) => {
        const p = paintLeaf(pixels, leaf, looks);
        painted.push(...p.lines);
        return p;
      },
      label,
      caption,
    );
    panels = panelsFound;
  } else {
    textLines = ocr.lines;
    uncertain = ocr.uncertain;
    painted = paintLines(ocr.rows, background, looks);
    html = render(painted, kind, label, background, foreground, caption);
  }

  const colorChanges: ColorChange[] = [];
  if (rgbHex(foreground) !== rgbHex(measured.foreground)) {
    colorChanges.push({
      element: "text",
      original: rgbHex(measured.foreground),
      adjusted: rgbHex(foreground),
      contrast_after: round2(contrast(foreground, background)),
    });
  }

  const review: Review = {
    type: kind,
    low_confidence_words: uncertain,
    original_colors: {
      background: rgbHex(measured.background),
      foreground: rgbHex(measured.foreground),
    },
    contrast_changes: colorChanges,
    text_color: rgbHex((transcript === null && mainColor(painted)) || foreground),
    colors_used: transcript !== null ? [rgbHex(foreground)] : colorsUsed(painted),
    panels,
    icons_removed: transcript !== null ? [] : icons.map((w) => w.text),
    second_color_ratio: round2(measured.secondaryRatio),
    check_colors_by_hand: kind === "code" || measured.secondaryRatio >= 0.3,
    contrast_ratio: round2(contrast(foreground, background)),
    canvas_issues: checkCanvasSafe(html),
    privacy: {
      home_path_masking: true,
      learned_email_identity_masking: true,
      generic_email_replacement: false,
      manual_review_required: true,
    },
    limitations: [
      "OCR requires character-by-character review",
      "Whitespace reconstruction is approximate",
      "Text colors are measured per letter from the screenshot; thin or tiny letters can pick up a blended color",
      "Colors are raised to 4.5:1 contrast where needed, so some differ slightly from the screenshot",
      "Panels are found from separator lines; panels without a visible line stay together",
      "Icons are not reconstructed; OCR may read them as stray characters",
      "Diagram geometry is not reconstructed",
      "Animated GIFs use their final frame",
      "Username masking is pattern-based and incomplete",
    ],
  };

  const stem = rawStem.replace(/[^\p{L}\p{N}_.-]+/gu, "_");
  const transcriptText = textLines.join("\n");

  return {
    html,
    transcript: transcriptText,
    review,
    lineCount: textLines.length,
    lowConfidenceCount: uncertain.length,
    panelsFound,
    fromTranscript: transcript !== null,
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

export function issuesFor(result: ConvertResult): Issue[] {
  const { review } = result;
  const issues: Issue[] = [];
  const words = review.low_confidence_words.map((w) => w.text);

  if (words.length) {
    issues.push({ level: "error", text: `${words.length} low-confidence words — check these first.`, words });
  }
  for (const canvas of review.canvas_issues) {
    issues.push({ level: canvas.level === "error" ? "error" : "warn", text: `Canvas: ${canvas.message}.` });
  }
  if (review.type !== "interface" && result.panelsFound > 1 && !result.fromTranscript) {
    issues.push({
      level: "warn",
      text: `This looks like an application window (${result.panelsFound} panels). Choose type UI to rebuild the panels.`,
    });
  }
  if (result.fromTranscript) {
    issues.push({
      level: "info",
      text: "Built from your corrected text: one text color, no panels. Convert without it to get colors and panels back.",
    });
  } else if (review.check_colors_by_hand) {
    issues.push({
      level: "warn",
      text: `${review.colors_used.length} text colors measured from the screenshot. Check them against the original.`,
    });
  }
  if (review.icons_removed.length) {
    issues.push({
      level: "info",
      text: `${review.icons_removed.length} icons left out (OCR read them as stray characters).`,
      words: review.icons_removed,
    });
  }
  const change = review.contrast_changes[0];
  if (change) {
    issues.push({
      level: "info",
      text: `Main text color adjusted from ${change.original} to ${change.adjusted} for contrast.`,
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
