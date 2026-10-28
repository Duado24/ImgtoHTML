import { measureFont, chromeNoise, splitItems, itemBox, panelBackground, treeArrows, MONO_FONT, UI_FONT } from "./panel-features";
import { renderLayout, checkLayout, refineLayout, type LayoutAttempt, type VisionLayout } from "./vision-layout";
/** Screenshot → Canvas HTML draft. Pure: takes decoded pixels and OCR
 *  words, returns the files to offer for download. The browser parts
 *  (decoding the image, running OCR) live in src/browser/. */

import { checkCanvasSafe, type CanvasIssue } from "./canvas";
import { colorDistance, colorsFromWords, contrast, dominantColor, fixContrast, rgbHex, xHeight } from "./colors";
import { layoutWords, type UncertainWord } from "./layout";
import { buildModel, flagsByRegion, type ReviewState, type ScreenshotModel } from "./model";
import { cleanCode, detectLanguage, highlightCode, measuredTheme, repairJsonBraces, type CodeCleanup } from "./code";
import { renderDiagram, unconfirmedLabels, type Diagram } from "./diagram";
import { codeRows, renderEditorWindow } from "./editor-window";
import { colorRoles } from "./terminal";
import { mergeVision, type RegionReading } from "./vision";
import { CODE_THEME, applyTheme, themeFor } from "./theme";
import { colorsUsed, mainColor, measureLooks, paintLines, plainLines, type PaintedLine, type WordLook } from "./paint";
import { learnedUsernames, sanitizeLines, sanitizeText } from "./privacy";
import { segment, type Leaf, type Region } from "./regions";
import { escapeHtml, render, renderLayoutPanel, renderPanels, type PaintedLeaf } from "./render";
import { isIconNoise, type Box, type Kind, type OcrWord, type Pixels, type RGB } from "./types";
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
  /** Code screenshots: draw the editor window (sidebar, tabs, line numbers). Default true. */
  editorWindow?: boolean;
  layout?: VisionLayout | null;
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
  layout?: VisionLayout | null;
  /** Which renderer drew the HTML and, when it isn't the layout renderer, why. */
  layout_status: {
    renderer: Renderer;
    application: VisionLayout["application"] | null;
    reason: string | null;
    /** Server only: each answer the vision model gave, and why it was rejected. */
    attempts?: LayoutAttempt[];
  };
  /** Server only: the build that produced this result (see /api/version). */
  server_build?: string;
  visual_validation?: { discrepancies: { component: string; error: number }[]; pixelMeanAbsoluteError: number; repaired: boolean; error?: string };
  low_confidence_words: UncertainWord[];
  original_colors: { background: string; foreground: string };
  contrast_changes: ColorChange[];
  /** Course theme used (terminal and code), or null for the screenshot's own colors. */
  theme: string | null;
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
  /** Regions with flagged text, least confident first (details in the model file). */
  regions_to_review: { region: string; confidence: number | null; flags: number }[];
  /** Code screenshots: detected language and the clean-up applied to the OCR text. */
  /** `colors_measured`: syntax colors taken from the screenshot; the rest are VS Code Dark+. */
  code_panels?: { component: string; cleanup: NonNullable<Review["code"]>; colors_measured: string[] }[];
  /** `arrows`: tree-view arrow glyphs OCR read as letters, drawn as › or ⌄. */
  panel_features?: { component: string; font: ReturnType<typeof measureFont>; icons_removed: string[]; arrows: { from: string; to: string }[] }[];
  code: { editor_window: boolean; language: string | null; line_numbers_removed: boolean; lines_outside_code: number; panels_left_out: number; quotes_straightened: number; braces_repaired: number; duplicate_quotes_removed?: number; lines_highlighted?: number; indent_unit: number | null; lines_snapped: number } | null;
  /** Diagrams described by the vision model: size, and labels OCR didn't confirm. */
  diagram: { parts: number; connections: number; unconfirmed_labels: string[] } | null;
  /** The vision model that also read the screenshot, or null when none ran. */
  /** `corrected`: OCR words replaced by the vision model's reading (lookalike characters only). */
  vision: { model: string; regions_read: number; error?: string; corrected?: { from: string; to: string }[] } | null;
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
  /** Screen-reader label and visible caption as used (defaults filled in). */
  label: string;
  caption: string | null;
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
  /** Regions, lines and spans with confidence and source (see model.ts). */
  model: ScreenshotModel;
  modelFile: OutputFile;
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

/** The panel holding the code: the one whose lines have the most gutter
 *  numbers, else the one with the most words. */
function editorPanel(tree: Region): { leaf: Leaf; cleaned: CodeCleanup } {
  const panels = leaves(tree).map((leaf) => ({ leaf, cleaned: cleanCode(layoutWords(leaf.words).lines) }));
  const rank = (p: (typeof panels)[number]): [number, number] =>
    [p.cleaned.lineNumbersRemoved ? 1 : 0, p.cleaned.lineNumbersRemoved ? p.cleaned.lines.length : p.leaf.words.length];
  return panels.reduce((best, p) => {
    const [a, b] = rank(p);
    const [c, d] = rank(best);
    return a > c || (a === c && b > d) ? p : best;
  });
}

export type Renderer = "layout" | "editor-window" | "code" | "transcript" | "panels" | "rows";
/** Applications whose component tree replaces the chosen screenshot type. */
const LAID_OUT: readonly string[] = ["ide", "code-editor", "website", "desktop"];
/** How far (sum of channel differences) a pixel must be from the background to count as ink. */
const INK = 60;

/** Distance from the panel background at which a code line's own background counts. */
const LINE_BACKGROUND = 12;

/** Per code line, its background where it differs from the panel's (the
 *  current line, a selection, a diff or error band), measured across the
 *  panel on the line's numbered OCR row. Empty when the numbered rows don't
 *  match the code lines one for one, or when most lines would differ (then
 *  it's the panel color that was mismeasured, not a highlight). */
function codeLineBackgrounds(pixels: Pixels, words: readonly OcrWord[], box: Box, panel: RGB, lines: number): (string | undefined)[] {
  const numbered = layoutWords(words).rows.map((r) => r.words.map((w) => w.word).sort((a, b) => a.x - b.x)).filter((ws) => /^\d{1,4}$/.test(ws[0]?.text ?? ""));
  if (numbered.length !== lines) return [];
  const backgrounds = numbered.map((ws) => {
    const top = Math.min(...ws.map((w) => w.y)), bottom = Math.max(...ws.map((w) => w.y + w.height));
    const color = dominantColor(pixels, { x: box.x, y: top, width: box.width, height: Math.max(1, bottom - top) });
    return colorDistance(color, panel) > LINE_BACKGROUND ? rgbHex(color) : undefined;
  });
  return backgrounds.filter(Boolean).length * 2 > lines ? [] : backgrounds;
}

/** The color letter `index` of `word` looks, from its ink pixels inside its
 *  OCR symbol box (or an even slice of the word box when the engine gave no
 *  symbols). Smoothed screen text has pale cores and colorful edges, and the
 *  eye blends them: the hue comes from all the ink (away from the
 *  background), the strength from the core, the half farthest from it.
 *  Empty when the letter shows no ink. */
export function letterInk(pixels: Pixels, word: OcrWord, index: number, background?: RGB): RGB[] {
  if (!background) return [];
  const symbols = word.symbols?.map((s) => s.text).join("") === word.text ? word.symbols : undefined;
  const slice = word.width / Math.max(1, word.text.length);
  const box = symbols?.[index] ?? { x: word.x + slice * index, y: word.y, width: slice, height: word.height };
  const ink: { color: RGB; distance: number }[] = [];
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(pixels.height, Math.ceil(box.y + box.height)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(pixels.width, Math.ceil(box.x + box.width)); x++) {
      const o = (y * pixels.width + x) * 4;
      const color: RGB = [pixels.data[o]!, pixels.data[o + 1]!, pixels.data[o + 2]!];
      const distance = Math.abs(color[0] - background[0]) + Math.abs(color[1] - background[1]) + Math.abs(color[2] - background[2]);
      if (distance > INK) ink.push({ color, distance });
    }
  }
  if (!ink.length) return [];
  const away = [0, 1, 2].map((c) => ink.reduce((n, p) => n + p.color[c]! - background[c]!, 0) / ink.length);
  const core = ink.sort((a, b) => b.distance - a.distance).slice(0, Math.ceil(ink.length / 2));
  const strength = core.reduce((n, p) => n + p.distance, 0) / core.length;
  const scale = strength / Math.max(1, Math.abs(away[0]!) + Math.abs(away[1]!) + Math.abs(away[2]!));
  const channel = (c: number) => Math.round(Math.min(255, Math.max(0, background[c]! + away[c]! * scale)));
  return [[channel(0), channel(1), channel(2)]];
}

export function convert(input: ConvertInput): ConvertResult {
  const { pixels, animated } = input;
  const checked = input.layout ? checkLayout(input.layout, pixels.width, pixels.height) : null;
  const detected = checked?.layout ? refineLayout(checked.layout, pixels, input.words) : null;
  const skipLayout =
    input.kind === "diagram" ? "diagrams are described, not laid out"
    : input.transcript?.trim() ? "a corrected transcript was given"
    : input.editorWindow === false ? "the editor window option is off"
    : !checked ? "no layout was detected"
    : !detected ? `the layout was invalid: ${checked.problem}`
    : !LAID_OUT.includes(detected.application) ? `"${detected.application}" screenshots use the ${input.kind} renderer`
    : null;
  const layout = skipLayout === null ? detected : null;
  const kind = layout ? "interface" : input.kind;
  let renderer: Renderer;

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
  const model = buildModel(pixels.width, pixels.height, kind, tree, words);
  // Terminals and code use the course theme; other kinds keep the screenshot's colors.
  const theme = themeFor(kind);
  const boxBackground = theme?.background ?? background;
  const boxText = theme?.colors.text ?? foreground;

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
  let code: Review["code"] = null;
  const codePanels: NonNullable<Review["code_panels"]> = [];
  const panelFeatures: NonNullable<Review["panel_features"]> = [];

  if (layout) {
    renderer = "layout";
    textLines = ocr.lines;
    uncertain = ocr.uncertain;
    painted = [];
    html = renderLayout(layout, words, pixels.width, label, caption, (panelWords, box, component) => {
      const bg = panelBackground(pixels, box);
      const fg = fixContrast(foreground, bg);
      if (component?.type === "code") {
        const raw = layoutWords(panelWords).lines;
        const cleaned = cleanCode(raw);
        const language = detectLanguage(cleaned.lines.join("\n"));
        const repaired = language === "json" ? repairJsonBraces(cleaned.lines) : { lines: cleaned.lines, repaired: 0 };
        // Duplicate opening quotes before a nonempty JSON value are a localized OCR artifact.
        const normalized = language === "json" ? repaired.lines.map((l) => l.replace(/^(\s*"[^"]+"\s*:\s*)"{2}(?=[\p{L}\p{N}_./])/u, '$1"')) : repaired.lines;
        // The screenshot's own syntax colors where it shows enough of each kind; Dark+ otherwise.
        const ocrRows = layoutWords(panelWords).rows.map((r) => r.words.map((w) => w.word));
        const { theme: own, measured } = measuredTheme(ocrRows, language, CODE_THEME, (w, i) => letterInk(pixels, w as OcrWord, i, looks.get(w as OcrWord)?.background));
        const palette = { ...own, background: bg, colors: Object.fromEntries(Object.entries(own.colors).map(([k, color]) => [k, fixContrast(color, bg)])) as typeof CODE_THEME.colors };
        const highlighted = highlightCode(normalized.join("\n"), language, palette).map((line) => ({ ...line, runs: line.runs.map((run) => ({ ...run, color: run.color ? fixContrast(run.color, bg) : undefined })) }));
        painted.push(...highlighted);
        const details: NonNullable<Review["code"]> = { editor_window: true, language, line_numbers_removed: cleaned.lineNumbersRemoved, lines_outside_code: cleaned.linesOutsideCode, panels_left_out: 0, quotes_straightened: cleaned.quotesStraightened, braces_repaired: repaired.repaired, duplicate_quotes_removed: normalized.filter((l, i) => l !== repaired.lines[i]).length, indent_unit: cleaned.indentUnit, lines_snapped: cleaned.linesSnapped };
        codePanels.push({ component: component.id, cleanup: details, colors_measured: measured });
        code ??= details;
        const plain = (lines: string[]) => lines.map((l) => `<div style="white-space:pre;">${escapeHtml(l)}</div>`).join("");
        // Keep observed text outside the gutter, including footer labels and code hints.
        const lastNumber = cleaned.lineNumbersRemoved ? raw.reduce((last, l, i) => /^\s*\d{1,4}(\s+|$)/.test(l) ? i : last, -1) : raw.length - 1;
        const suffix = raw.slice(lastNumber + 1);
        const codeStarts = layoutWords(panelWords).rows.flatMap((row) => {
          const ordered = row.words.map((w) => w.word).sort((a, b) => a.x - b.x);
          return ordered[0] && /^\d{1,4}$/.test(ordered[0].text) && ordered[1] ? [ordered[1].x] : [];
        });
        const gutterWidth = codeStarts.length >= 3 ? Math.max(20, Math.min(...codeStarts) - box.x - 8) : 40;
        const lineBackgrounds = codeLineBackgrounds(pixels, panelWords, box, bg, highlighted.length);
        details.lines_highlighted = lineBackgrounds.filter(Boolean).length;
        const rows = cleaned.lineNumbersRemoved ? codeRows(highlighted, cleaned.hints, cleaned.firstLine, rgbHex(palette.colors.text), false, gutterWidth, codeStarts.length >= 3 ? 8 : 14, lineBackgrounds)
          : highlighted.map((l) => `<tr><td style="padding:0;white-space:pre;">${l.runs.map((r) => `<span style="color:${rgbHex(r.color ?? palette.colors.text)};">${escapeHtml(r.text)}</span>`).join("")}</td></tr>`).join("");
        return `<div style="min-height:${Math.round(box.height)}px;background-color:${rgbHex(bg)};color:${rgbHex(palette.colors.text)};font:13px/1.45 ${MONO_FONT};overflow:hidden;">${plain(cleaned.header)}<table style="width:100%;border-collapse:collapse;border:none;color:${rgbHex(palette.colors.text)};font:13px/1.45 ${MONO_FONT};"><tbody>${rows}</tbody></table>${plain(suffix)}</div>`;
      }
      const removed = component ? panelWords.filter((w) => chromeNoise(w, component)) : [];
      const arrows = component ? treeArrows(panelWords, component) : new Map<OcrWord, string>();
      const visible = panelWords.filter((w) => !removed.includes(w)).map((w) => {
        const text = arrows.get(w);
        if (text === undefined) return w;
        // Same box and measured look, drawn as the arrow it is.
        const arrow = { ...w, text, symbols: undefined };
        const look = looks.get(w);
        if (look) looks.set(arrow, { ...look, letters: [look.letters.find(Boolean)] });
        return arrow;
      });
      const font = measureFont(visible, component?.type === "terminal" ? MONO_FONT : UI_FONT);
      if (component) panelFeatures.push({ component: component.id, font, icons_removed: removed.map((w) => w.text), arrows: [...arrows].map(([w, to]) => ({ from: w.text, to })) });
      const draw = (ws: OcrWord[], bounds: typeof box) => {
        const background = bounds.height > 0 ? panelBackground(pixels, bounds) : bg;
        const panel = paintLeaf(pixels, { kind: "leaf", box: bounds, background, words: ws }, looks);
        painted.push(...panel.lines);
        return renderLayoutPanel(panel, background, fixContrast(fg, background), bounds.height, font.family);
      };
      if (component && ["tabs", "toolbar", "menu"].includes(component.type)) {
        const rows = layoutWords(visible).rows.filter((r) => r.words.length);
        return rows.map((row) => {
          const items = splitItems(row.words.map((w) => w.word), pixels);
          const height = rows.length > 1 ? Math.min(box.height / rows.length, 20) : box.height;
          return '<table role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse;border:none;"><tbody><tr>' + items.map((item, i) => {
            const bounds = itemBox(item, { ...box, height });
            const next = items[i + 1];
            const right = next ? Math.min(...next.map((w) => w.x)) - 4 : box.x + box.width;
            const width = Math.max(1, right - (i === 0 ? box.x : bounds.x));
            return `<td style="width:${100 * width / box.width}%;vertical-align:top;padding:0;border:none;">${draw(item, bounds)}</td>`;
          }).join("") + '</tr></tbody></table>';
        }).join("");
      }
      // UI indentation uses pixel padding rather than spaces in a proportional font.
      if (font.family === UI_FONT) {
        let previousY = box.y;
        let first = true;
        return `<div style="min-height:${Math.round(box.height)}px;background-color:${rgbHex(bg)};">` + layoutWords(visible).rows.filter((row) => row.words.length).map((row) => {
          const ws = row.words.map((w) => w.word);
          const x = Math.min(...ws.map((w) => w.x));
          const y = Math.min(...ws.map((w) => w.y));
          const gap = Math.max(0, y - previousY - (first ? 0 : 18.85));
          previousY = y;
          first = false;
          return `<div style="padding-top:${gap}px;padding-left:${Math.max(0, Math.round(x - box.x))}px;">${draw(ws, { ...box, x, width: box.width - (x - box.x), height: 0 })}</div>`;
        }).join("") + '</div>';
      }
      return draw(visible, box);
    }, pixels);
    panels = layout.components.length;
  } else if (kind === "code" && theme) {
    // Code is re-highlighted by language rather than painted from pixels.
    // A corrected transcript is used as typed; OCR text is cleaned first,
    // from the editor panel only (not the sidebar or terminal beside it).
    const editor = transcript === null ? editorPanel(tree) : null;
    const cleaned = editor?.cleaned ?? null;
    textLines = cleaned?.lines ?? sanitizeLines(transcript!.split("\n")).lines;
    uncertain = editor ? layoutWords(editor.leaf.words).uncertain : [];
    const language = detectLanguage(textLines.join("\n"));
    // OCR text only: a typed transcript is used exactly as given.
    const braces = language === "json" && cleaned ? repairJsonBraces(textLines) : { lines: textLines, repaired: 0 };
    textLines = braces.lines;
    painted = highlightCode(textLines.join("\n"), language, theme);
    // Draw the editor window (sidebar, tabs, line numbers) when the
    // screenshot is an editor with numbered lines, unless turned off.
    const framed = editor !== null && cleaned!.lineNumbersRemoved && input.editorWindow !== false;
    renderer = framed ? "editor-window" : "code";
    if (framed) {
      const sidebar = leaves(tree)
        .filter((l) => l !== editor.leaf && l.words.length && l.box.x + l.box.width <= editor.leaf.box.x + 4)
        .sort((a, b) => b.words.length - a.words.length)[0];
      html = renderEditorWindow(
        painted,
        { sidebar: sidebar ? layoutWords(sidebar.words).lines : null, header: cleaned!.header, hints: cleaned!.hints, firstLine: cleaned!.firstLine },
        rgbHex(theme.colors.text),
        label,
        caption,
      );
    } else {
      html = render(painted, kind, label, boxBackground, boxText, caption);
    }
    code = {
      editor_window: framed,
      language,
      line_numbers_removed: cleaned?.lineNumbersRemoved ?? false,
      lines_outside_code: cleaned?.linesOutsideCode ?? 0,
      panels_left_out: editor ? panelsFound - 1 : 0,
      quotes_straightened: cleaned?.quotesStraightened ?? 0,
      braces_repaired: braces.repaired,
      indent_unit: cleaned?.indentUnit ?? null,
      lines_snapped: cleaned?.linesSnapped ?? 0,
    };
  } else if (transcript !== null) {
    // Corrected text has no positions, so: one color, one box.
    renderer = "transcript";
    textLines = sanitizeLines(transcript.split("\n")).lines;
    uncertain = [];
    painted = plainLines(textLines);
    html = render(painted, kind, label, boxBackground, boxText, caption);
  } else if (kind === "interface" && tree.kind === "split") {
    renderer = "panels";
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
    renderer = "rows";
    textLines = ocr.lines;
    uncertain = ocr.uncertain;
    painted = paintLines(ocr.rows, background, looks);
    if (theme) painted = applyTheme(painted, theme, measured.foreground, background);
    if (theme && kind === "terminal") painted = colorRoles(painted, theme);
    html = render(painted, kind, label, boxBackground, boxText, caption);
  }

  const colorChanges: ColorChange[] = [];
  if (!theme && rgbHex(foreground) !== rgbHex(measured.foreground)) {
    colorChanges.push({
      element: "text",
      original: rgbHex(measured.foreground),
      adjusted: rgbHex(foreground),
      contrast_after: round2(contrast(foreground, background)),
    });
  }

  const review: Review = {
    type: kind,
    layout,
    layout_status: { renderer, application: checked?.layout?.application ?? null, reason: skipLayout },
    low_confidence_words: uncertain,
    original_colors: {
      background: rgbHex(measured.background),
      foreground: rgbHex(measured.foreground),
    },
    contrast_changes: colorChanges,
    theme: theme?.name ?? null,
    text_color: rgbHex((transcript === null && mainColor(painted)) || boxText),
    colors_used: transcript !== null ? [rgbHex(boxText)] : colorsUsed(painted),
    panels,
    icons_removed: transcript !== null ? [] : icons.map((w) => w.text),
    second_color_ratio: round2(measured.secondaryRatio),
    check_colors_by_hand: !theme && measured.secondaryRatio >= 0.3,
    contrast_ratio: round2(contrast(boxText, boxBackground)),
    canvas_issues: checkCanvasSafe(html),
    regions_to_review: regionsToReview(model),
    vision: null,
    code,
    ...(layout ? { code_panels: codePanels, panel_features: panelFeatures } : {}),
    diagram: null,
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
    label,
    caption,
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
    model,
    modelFile: { name: `${stem}_model.json`, mime: "application/json", content: JSON.stringify(model, null, 2) },
  };
}

const regionsToReview = (model: ScreenshotModel) =>
  flagsByRegion(model).map((r) => ({ region: r.region, confidence: r.confidence, flags: r.flags.length }));

/** Add a vision model's readings (or why it couldn't run) to a result.
 *  The HTML and transcript stay as OCR read them. */
export function addVision(result: ConvertResult, model: string, readings: readonly RegionReading[], error?: string): ConvertResult {
  // The vision model reads the original pixels, so mask usernames in its text
  // too, learning names from every region (a path in one, an email in another).
  const names = learnedUsernames(readings.flatMap((r) => r.text.split("\n")));
  const masked = readings.map((r) => ({ ...r, text: r.text.split("\n").map((l) => sanitizeText(l, names)).join("\n") }));
  const merged = mergeVision(result.model, masked);
  const review: Review = {
    ...result.review,
    regions_to_review: regionsToReview(merged),
    vision: { model, regions_read: readings.length, ...(error ? { error } : {}) },
  };
  return {
    ...result,
    review,
    model: merged,
    reviewFile: { ...result.reviewFile, content: JSON.stringify(review, null, 2) },
    modelFile: { ...result.modelFile, content: JSON.stringify(merged, null, 2) },
  };
}

/** Diagrams: replace the OCR text box with the vision model's description. */
export function addDiagram(result: ConvertResult, diagram: Diagram): ConvertResult {
  const html = renderDiagram(diagram, result.label, result.caption);
  const review: Review = {
    ...result.review,
    canvas_issues: checkCanvasSafe(html),
    diagram: {
      parts: diagram.nodes.length,
      connections: diagram.edges.length,
      unconfirmed_labels: unconfirmedLabels(diagram, result.transcript),
    },
  };
  return {
    ...result,
    html,
    review,
    htmlFile: { ...result.htmlFile, content: html },
    reviewFile: { ...result.reviewFile, content: JSON.stringify(review, null, 2) },
  };
}

/** Record the reviewer's decisions (approved, corrected, skipped) on regions.
 *  Decided regions keep their flags in the model but leave the review list. */
export function applyDecisions(result: ConvertResult, decisions: ReadonlyMap<string, ReviewState>): ConvertResult {
  if (!decisions.size) return result;
  const model = {
    ...result.model,
    regions: result.model.regions.map((r) => (decisions.has(r.id) ? { ...r, review: decisions.get(r.id)! } : r)),
  };
  const review: Review = { ...result.review, regions_to_review: regionsToReview(model) };
  return {
    ...result,
    review,
    model,
    reviewFile: { ...result.reviewFile, content: JSON.stringify(review, null, 2) },
    modelFile: { ...result.modelFile, content: JSON.stringify(model, null, 2) },
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
  // Only regions still waiting for review; approved or skipped ones are settled.
  const waiting = result.model.regions.filter((r) => r.review === "pending");
  const pending = waiting.flatMap((r) => r.flags);
  const spanText = new Map(waiting.flatMap((r) => r.lines.flatMap((l) => l.spans)).map((s) => [s.id, s.text]));
  // A corrected transcript replaced the OCR text, so its OCR doubts no longer apply.
  const words = result.fromTranscript
    ? []
    : pending.filter((f) => f.reason === "low-confidence").flatMap((f) => spanText.get(f.spanId) ?? []);

  if (words.length) {
    issues.push({ level: "error", text: `${words.length} low-confidence words — check these first.`, words });
  }
  if (review.vision?.error) {
    issues.push({ level: "warn", text: `Vision model didn't run (${review.vision.error}); OCR only.` });
  }
  if (review.diagram) {
    issues.push({
      level: "info",
      text: `Diagram described as ${review.diagram.parts} parts and ${review.diagram.connections} connections. Upload the image to Canvas and put this description with it.`,
    });
    if (review.diagram.unconfirmed_labels.length) {
      issues.push({
        level: "warn",
        text: "The vision model read these labels, but OCR didn't see them — check them against the image.",
        words: review.diagram.unconfirmed_labels,
      });
    }
  } else if (review.type === "diagram") {
    issues.push({ level: "warn", text: "Diagram structure needs the vision model; this is only the text OCR found." });
  }
  if (review.code) {
    const { editor_window, language, line_numbers_removed, lines_outside_code, panels_left_out, quotes_straightened, braces_repaired, indent_unit, lines_snapped } =
      review.code;
    const lines = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
    const notes = [
      language ? `Highlighted as ${language === "xml" ? "HTML/XML" : language}` : "Language not recognized; shown without syntax colors",
      ...(editor_window
        ? ["drawn as the editor window (sidebar, tabs and line numbers are hidden from screen readers)"]
        : [
            ...(panels_left_out ? [`only the code panel is used (${panels_left_out} other ${panels_left_out === 1 ? "panel" : "panels"} such as the sidebar left out)`] : []),
            ...(line_numbers_removed ? ["line numbers removed so copied code runs"] : []),
            ...(lines_outside_code ? [`${lines(lines_outside_code)} of editor text left out (tabs, breadcrumbs, hints)`] : []),
          ]),
      ...(quotes_straightened ? [`curly quotes made straight on ${lines(quotes_straightened)}`] : []),
      ...(braces_repaired ? [`${braces_repaired} misread ${braces_repaired === 1 ? "brace" : "braces"} repaired — check them`] : []),
      ...(lines_snapped ? [`indentation of ${lines_snapped} ${lines_snapped === 1 ? "line" : "lines"} snapped to ${indent_unit} spaces — check it`] : []),
    ];
    issues.push({ level: lines_snapped || braces_repaired ? "warn" : "info", text: notes.join("; ") + "." });
  }
  const disagree = pending.filter((f) => f.reason === "sources-disagree");
  if (disagree.length) {
    issues.push({
      level: "error",
      text: `${disagree.length} ${disagree.length === 1 ? "word reads" : "words read"} differently to OCR and the vision model — check these.`,
      words: disagree.map((f) => f.detail),
    });
  }
  const fixes = pending.filter((f) => f.reason === "suggested-fix");
  if (fixes.length) {
    issues.push({
      level: "error",
      text: `${fixes.length} likely misread ${fixes.length === 1 ? "command" : "commands"} — check before students copy them.`,
      words: fixes.map((f) => f.detail),
    });
  }
  for (const canvas of review.canvas_issues) {
    issues.push({ level: canvas.level === "error" ? "error" : "warn", text: `Canvas: ${canvas.message}.` });
  }
  // Code already picks its editor panel; other types may be an app window.
  if (review.type !== "interface" && review.type !== "code" && result.panelsFound > 1 && !result.fromTranscript) {
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
