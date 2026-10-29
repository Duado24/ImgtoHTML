import { countWordsToCheck, type ModelRegion, type ScreenshotModel } from "../core/model";
import type { ConvertResult } from "../core/convert";

export function reviewCounts(regions: readonly ModelRegion[]) {
  const counts = { pending: 0, approved: 0, corrected: 0, skipped: 0 };
  for (const region of regions) if (region.flags.length || region.reviewRequested) counts[region.review]++;
  return counts;
}

export function reviewReadyText(regions: readonly ModelRegion[]): string {
  const { pending, skipped } = reviewCounts(regions);
  if (pending) return `Draft ready. ${pending} ${pending === 1 ? "thing" : "things"} to check before Canvas.${skipped ? ` ${skipped} skipped; their text is unverified.` : ""}`;
  if (skipped) return `Review finished: ${skipped} ${skipped === 1 ? "check" : "checks"} skipped; their text is unverified.`;
  return "Draft ready. Nothing left to review.";
}

/** A skip is still unverified; only an approval or saved correction is checked. */
export function checklistSummary(model: ScreenshotModel) {
  const counts = reviewCounts(model.regions);
  const checked = counts.approved + counts.corrected;
  const total = checked + counts.pending + counts.skipped;
  const remaining = counts.pending + counts.skipped;
  return {
    ...counts, checked, total, remaining,
    words: countWordsToCheck(model),
    percent: total ? Math.round(checked / total * 100) : 100,
    heading: remaining ? `${remaining} ${remaining === 1 ? "thing" : "things"} to check before you paste this into Canvas` : "Ready to paste",
  };
}

/** Words listed per reason before "and N more". */
const REASON_WORDS = 6;

/** Translate the OCR's internal labels into a useful question for a teacher:
 *  one line per kind of doubt, naming the words it is about. */
export function reviewReasons(region: ModelRegion): string[] {
  const spans = new Map(region.lines.flatMap((line) => line.spans).map((span) => [span.id, span]));
  const groups = new Map<string, string[]>();
  for (const flag of region.flags) {
    const text = spans.get(flag.spanId)?.text ?? "";
    let reason: string;
    switch (flag.reason) {
      case "low-confidence": reason = "The text is blurry here"; break;
      case "confusable":
        reason = /[lI1|]/.test(text) ? "These could be l (L), I (capital i), or 1 (one)"
          : /[O0]/.test(text) ? "These could be O (the letter) or 0 (zero)"
          : "Some punctuation marks look alike here";
        break;
      case "sources-disagree": reason = "Read in two different ways (choose the reading that matches)"; break;
      case "suggested-fix": reason = "Another reading is possible (compare it with the picture)"; break;
      default: reason = "Cut off in the screenshot (the … marks where the picture ends)";
    }
    const words = groups.get(reason) ?? [];
    if (text && !words.includes(text)) words.push(text);
    groups.set(reason, words);
  }
  return [...groups].map(([reason, words]) => {
    if (!words.length) return `${reason}.`;
    const shown = words.slice(0, REASON_WORDS).map((word) => `“${word}”`).join(", ");
    const more = words.length > REASON_WORDS ? ` and ${words.length - REASON_WORDS} more` : "";
    return `${reason}: ${shown}${more}.`;
  });
}

/** Most important first. The order ignores review state, so a card keeps
 *  its place and its number after it is checked. */
export function checklistRegions(regions: readonly ModelRegion[]): ModelRegion[] {
  const urgency = (region: ModelRegion) => region.flags.reduce((sum, flag) => sum + (flag.reason === "sources-disagree" || flag.reason === "cut-off" ? 3 : flag.reason === "low-confidence" ? 2 : 1), 0);
  return regions.filter((region) => region.flags.length || region.reviewRequested).sort((a, b) =>
    urgency(b) - urgency(a) || (a.confidence ?? 0) - (b.confidence ?? 0) || a.box.y - b.box.y || a.box.x - b.box.x);
}

export interface FocusLine {
  box: ModelRegion["box"];
  /** Text pieces in reading order; `flagged` ones are the words to check. */
  parts: { text: string; flagged: boolean }[];
}

/** The lines from the first to the last one holding a flagged word, so a
 *  card shows the doubtful words instead of the whole panel, and its text
 *  matches the cropped picture line for line. A cut-off word shows the …
 *  the HTML adds. Without flagged lines (a corrected region), every line. */
export function focusLines(region: ModelRegion): FocusLine[] {
  const flagged = new Set(region.flags.map((flag) => flag.spanId));
  const cutOff = new Set(region.flags.filter((flag) => flag.reason === "cut-off").map((flag) => flag.spanId));
  const hits = region.lines.map((line) => line.spans.some((span) => flagged.has(span.id)));
  const first = hits.indexOf(true);
  const lines = first < 0 ? region.lines : region.lines.slice(first, hits.lastIndexOf(true) + 1);
  return lines.map((line) => ({
    box: line.box,
    parts: line.spans.flatMap((span, i) => [
      ...(i ? [{ text: " ", flagged: false }] : []),
      { text: cutOff.has(span.id) && !/(?:…|\.{3})$/.test(span.text) ? `${span.text}…` : span.text, flagged: flagged.has(span.id) },
    ]),
  }));
}

/** Compare the original crop with emitted text, including code cleanup and
 * cutoff markers. A model region can cover several detected components. */
export function reviewReading(result: ConvertResult, region: ModelRegion): string {
  const source = region.lines.map((line) => line.spans.map((span) => span.text).join(" "));
  const overlap = (box: ModelRegion["box"]) => Math.max(0, Math.min(box.x + box.width, region.box.x + region.box.width) - Math.max(box.x, region.box.x)) *
    Math.max(0, Math.min(box.y + box.height, region.box.y + region.box.height) - Math.max(box.y, region.box.y));
  const components = result.review.layout?.components ?? [];
  const sections = (result.sections ?? []).flatMap((section) => {
    const component = components.find((component) => component.id === section.component);
    if (!component || overlap(component.box) < Math.min(component.box.width * component.box.height, region.box.width * region.box.height) / 2) return [];
    return [{ ...section, box: component.box }];
  }).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (sections.length) return sections.flatMap((section) => section.lines).join("\n");
  if (result.review.layout_status.renderer === "code" || result.review.layout_status.renderer === "editor-window") {
    const key = (line: string) => line.replace(/^\s*\d{1,4}\s+/, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s/g, "").replace(/…$/, "");
    const sourceKeys = new Set(source.map(key));
    const emitted = result.transcript.split("\n").filter((line) => sourceKeys.has(key(line)));
    if (emitted.length) return emitted.join("\n");
  }
  return source.join("\n");
}
