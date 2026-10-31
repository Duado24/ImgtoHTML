import { describe, expect, it } from "vitest";
import { checklistSummary, markLine, readyText, reasons, wordsToCheck, type Decision } from "../src/browser/review-status";
import type { Check } from "../src/core/convert";

const check = (region: string, unsure: string[] = ["wor1d"], cutOff: number[] = []): Check =>
  ({ region, title: "Code", lines: ["hello wor1d", "the end…"], unsure, cutOff });
const decided = (entries: [string, Decision][]) => new Map(entries);

describe("checklist", () => {
  it("counts the words to check and drops them as items are checked", () => {
    const checks = [check("a"), check("b", ["x", "y"], [2])];
    expect(wordsToCheck(checks, decided([]))).toBe(4);
    expect(wordsToCheck(checks, decided([["b", "approved"]]))).toBe(1);
    expect(wordsToCheck(checks, decided([["a", "corrected"], ["b", "approved"]]))).toBe(0);
  });

  it("never calls skipped items checked", () => {
    const checks = [check("a"), check("b")];
    expect(checklistSummary(checks, decided([["a", "skipped"], ["b", "approved"]])))
      .toMatchObject({ checked: 1, skipped: 1, remaining: 1, pending: 0, percent: 50, heading: "1 thing to check before you paste this into Canvas" });
    expect(readyText(checks, decided([["a", "skipped"], ["b", "approved"]]))).toBe("Checked, except 1 skipped; their text is unverified.");
    expect(checklistSummary(checks, decided([["a", "approved"], ["b", "corrected"]]))).toMatchObject({ heading: "Ready to paste", percent: 100 });
    expect(readyText([], decided([]))).toBe("Ready to paste. Nothing left to check.");
  });

  it("explains each item in everyday words", () => {
    expect(reasons(check("a", ["wor1d"], [2]))).toEqual([
      "The AI wasn't sure it read these right: “wor1d”.",
      "Cut off at the edge of the screenshot (the … marks where it ends): line 2.",
    ]);
  });

  it("marks unsure words and the … of a cut-off line", () => {
    expect(markLine("hello wor1d and wor1d", ["wor1d"], false)).toEqual([
      { text: "hello ", marked: false }, { text: "wor1d", marked: true }, { text: " and ", marked: false }, { text: "wor1d", marked: true },
    ]);
    expect(markLine("the end…", [], true)).toEqual([{ text: "the end", marked: false }, { text: "…", marked: true }]);
  });
});
