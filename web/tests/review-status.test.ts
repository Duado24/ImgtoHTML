import { expect, it } from "vitest";
import { checklistRegions, checklistSummary, focusLines, reviewCounts, reviewReadyText, reviewReading, reviewReasons } from "../src/browser/review-status";
import type { ConvertResult } from "../src/core/convert";
import type { ModelRegion, ReviewState, ScreenshotModel } from "../src/core/model";

const regions = (...states: ReviewState[]) => states.map((review) => ({ review, flags: [{}] }) as ModelRegion);

it("counts each flagged review state and ignores unflagged regions", () => {
  expect(reviewCounts([...regions("pending", "approved", "corrected", "skipped"), { review: "pending", flags: [] } as unknown as ModelRegion]))
    .toEqual({ pending: 1, approved: 1, corrected: 1, skipped: 1 });
});

it("never calls skipped text verified or nothing left to review", () => {
  expect(reviewReadyText(regions("skipped", "approved"))).toBe("Review finished: 1 check skipped; their text is unverified.");
  expect(reviewReadyText(regions("pending", "skipped"))).toContain("1 skipped; their text is unverified.");
  expect(reviewReadyText(regions("pending"))).toContain("1 thing to check");
  expect(reviewReadyText([...regions("pending"), ...regions("pending")])).not.toMatch(/region/);
  expect(reviewReadyText(regions("approved", "corrected"))).toContain("Nothing left to review");
  expect(reviewReadyText([])).toContain("Nothing left to review");
});

const region = (id: string, review: ReviewState, reason = "low-confidence"): ModelRegion => ({
  id, review, confidence: 0.4, role: "code", background: "#000000", box: { x: 0, y: 0, width: 100, height: 30 },
  flags: [{ spanId: `${id}.w1`, reason, detail: "technical OCR evidence" }] as ModelRegion["flags"],
  lines: [{ id: `${id}.l1`, box: { x: 0, y: 0, width: 100, height: 30 }, spans: [
    { id: `${id}.w1`, text: "wor1d", box: { x: 0, y: 0, width: 100, height: 30 }, source: "ocr", confidence: 0.4, alternatives: [] },
    { id: `${id}.w2`, text: "hello", box: { x: 0, y: 0, width: 100, height: 30 }, source: "ocr", confidence: 0.9, alternatives: [] },
  ] }],
});
const model = (...regions: ModelRegion[]) => ({ regions, width: 100, height: 30, version: 1, kind: "code" }) as ScreenshotModel;

it("updates words and progress as checks and fixes are completed", () => {
  // Each region has one flagged word ("wor1d") beside a clear one ("hello"): only the flagged one counts.
  expect(checklistSummary(model(region("r1", "pending"), region("r2", "pending"))))
    .toMatchObject({ words: 2, checked: 0, total: 2, percent: 0, heading: "2 things to check before you paste this into Canvas" });
  expect(checklistSummary(model(region("r1", "approved"), region("r2", "pending"))))
    .toMatchObject({ words: 1, checked: 1, percent: 50 });
  expect(checklistSummary(model(region("r1", "approved"), region("r2", "corrected"))))
    .toMatchObject({ words: 0, checked: 2, percent: 100, heading: "Ready to paste" });
});

it("keeps skipped items available and does not call them checked", () => {
  expect(checklistSummary(model(region("r1", "skipped"), region("r2", "approved"))))
    .toMatchObject({ words: 0, checked: 1, skipped: 1, remaining: 1, percent: 50, heading: "1 thing to check before you paste this into Canvas" });
  expect(checklistSummary(model())).toMatchObject({ words: 0, heading: "Ready to paste", percent: 100 });
});

it("explains uncertain readings in everyday words, one line per kind, naming the words", () => {
  expect(reviewReasons(region("r1", "pending"))).toEqual(["The text is blurry here: “wor1d”."]);
  const many = region("r2", "pending");
  many.lines[0]!.spans = Array.from({ length: 8 }, (_, i) => ({ ...many.lines[0]!.spans[0]!, id: `r2.w${i + 1}`, text: `w${i + 1}` }));
  many.flags = many.lines[0]!.spans.map((span) => ({ spanId: span.id, reason: "low-confidence", detail: "" }));
  expect(reviewReasons(many)).toEqual(["The text is blurry here: “w1”, “w2”, “w3”, “w4”, “w5”, “w6” and 2 more."]);
  expect(reviewReasons(region("r1", "pending", "confusable")).join(" ")).toContain("1 (one)");
  expect(reviewReasons(region("r1", "pending", "cut-off"))).toEqual(["Cut off in the screenshot (the … marks where the picture ends): “wor1d”."]);
  expect(reviewReasons(region("r1", "pending", "sources-disagree")).join(" ")).toContain("two different ways");
});

it("puts serious items first and keeps each card in place once checked", () => {
  const order = (...states: ReviewState[]) => checklistRegions([
    region("blurry", states[0]!), region("lookalike", states[1]!, "confusable"), region("cut", states[2]!, "cut-off"),
  ]).map((region) => region.id);
  expect(order("pending", "pending", "pending")).toEqual(["cut", "blurry", "lookalike"]);
  expect(order("approved", "skipped", "pending")).toEqual(["cut", "blurry", "lookalike"]);
});

it("focuses a card on the lines with doubtful words and marks them", () => {
  const spot = region("r1", "pending");
  spot.lines.push({ id: "r1.l2", box: { x: 0, y: 40, width: 100, height: 30 }, spans: [
    { id: "r1.l2.w1", text: "clear", box: { x: 0, y: 40, width: 50, height: 30 }, source: "ocr", confidence: 0.99, alternatives: [] },
  ] });
  expect(focusLines(spot)).toEqual([{ box: spot.lines[0]!.box, parts: [
    { text: "wor1d", flagged: true }, { text: " ", flagged: false }, { text: "hello", flagged: false },
  ] }]);
  expect(focusLines(region("r2", "pending", "cut-off"))[0]!.parts[0]).toEqual({ text: "wor1d…", flagged: true });
  // A clear line between two doubtful ones stays, so the text matches the cropped picture.
  spot.lines.push({ ...spot.lines[0]!, id: "r1.l3", box: { x: 0, y: 80, width: 100, height: 30 } });
  expect(focusLines(spot).map((line) => line.box.y)).toEqual([0, 40, 80]);
  spot.flags = [];
  expect(focusLines(spot)).toHaveLength(3);
});

it("shows emitted code cleanup and cutoff annotations beside the original", () => {
  const spot = region("r1", "pending");
  spot.lines[0]!.spans[0]!.text = "3";
  spot.lines[0]!.spans[1]!.text = '“description”: “Nod';
  const result = { review: { layout_status: { renderer: "code" } }, transcript: '  "description": "Nod…' } as ConvertResult;
  expect(reviewReading(result, spot)).toBe('  "description": "Nod…');
});

it("uses all emitted components inside an OCR region in reading order", () => {
  const spot = region("r1", "pending");
  const result = { review: { layout: { components: [
    { id: "code", box: { x: 0, y: 10, width: 100, height: 20 } },
    { id: "tab", box: { x: 0, y: 0, width: 100, height: 10 } },
  ] } }, sections: [{ component: "code", lines: ['"Nod…'] }, { component: "tab", lines: ["lesson.json"] }] } as ConvertResult;
  expect(reviewReading(result, spot)).toBe('lesson.json\n"Nod…');
});
