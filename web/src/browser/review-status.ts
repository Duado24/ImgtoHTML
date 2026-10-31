/** The checklist: what the AI wasn't sure about, and what the designer has
 *  checked against their screenshot. Approving or fixing an item checks it;
 *  skipping leaves it unverified. */

import type { Check } from "../core/convert";

export type Decision = "approved" | "corrected" | "skipped";
export type Decisions = ReadonlyMap<string, Decision>;

const decided = (d: Decision | undefined) => d === "approved" || d === "corrected";

/** Words still to check: unsure words and cut-off lines in items not yet checked. */
export function wordsToCheck(checks: readonly Check[], decisions: Decisions): number {
  return checks.filter((c) => !decided(decisions.get(c.region))).reduce((n, c) => n + c.unsure.length + c.cutOff.length, 0);
}

export function checklistSummary(checks: readonly Check[], decisions: Decisions) {
  const checked = checks.filter((c) => decided(decisions.get(c.region))).length;
  const skipped = checks.filter((c) => decisions.get(c.region) === "skipped").length;
  const total = checks.length;
  const remaining = total - checked;
  return {
    checked, skipped, total, remaining,
    pending: remaining - skipped,
    words: wordsToCheck(checks, decisions),
    percent: total ? Math.round((checked / total) * 100) : 100,
    heading: remaining ? `${remaining} ${remaining === 1 ? "thing" : "things"} to check before you paste this into Canvas` : "Ready to paste",
  };
}

/** Why an item is on the checklist, in everyday words. */
export function reasons(check: Check): string[] {
  const list = (words: readonly string[]) => words.map((w) => `“${w}”`).join(", ");
  return [
    ...(check.unsure.length ? [`The AI wasn't sure it read these right: ${list(check.unsure)}.`] : []),
    ...(check.cutOff.length ? [`Cut off at the edge of the screenshot (the … marks where it ends): line${check.cutOff.length === 1 ? "" : "s"} ${check.cutOff.join(", ")}.`] : []),
  ];
}

/** A line split into plain text and the words to check, for marking. */
export function markLine(line: string, unsure: readonly string[], cutOff: boolean): { text: string; marked: boolean }[] {
  const words = [...unsure].filter(Boolean).sort((a, b) => b.length - a.length);
  const parts: { text: string; marked: boolean }[] = [];
  let rest = line;
  while (rest) {
    const hits = words.map((w) => ({ w, at: rest.indexOf(w) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
    const hit = hits[0];
    if (!hit) { parts.push({ text: rest, marked: false }); break; }
    if (hit.at) parts.push({ text: rest.slice(0, hit.at), marked: false });
    parts.push({ text: hit.w, marked: true });
    rest = rest.slice(hit.at + hit.w.length);
  }
  // The … that marks a cut-off line is something to check too.
  if (cutOff) {
    const last = parts.at(-1);
    if (last && !last.marked && last.text.endsWith("…")) {
      last.text = last.text.slice(0, -1);
      parts.push({ text: "…", marked: true });
    }
  }
  return parts.filter((p) => p.text);
}

/** The status line after converting. */
export function readyText(checks: readonly Check[], decisions: Decisions): string {
  const { pending, skipped } = checklistSummary(checks, decisions);
  if (pending) return `Ready. ${pending} ${pending === 1 ? "thing" : "things"} to check before Canvas.${skipped ? ` ${skipped} skipped; their text is unverified.` : ""}`;
  if (skipped) return `Checked, except ${skipped} skipped; their text is unverified.`;
  return "Ready to paste. Nothing left to check.";
}
