import type { ModelRegion } from "../core/model";

export function reviewCounts(regions: readonly ModelRegion[]) {
  const counts = { pending: 0, approved: 0, corrected: 0, skipped: 0 };
  for (const region of regions) if (region.flags.length) counts[region.review]++;
  return counts;
}

export function reviewReadyText(regions: readonly ModelRegion[]): string {
  const { pending, skipped } = reviewCounts(regions);
  if (pending) return `Draft ready. ${pending} ${pending === 1 ? "region needs" : "regions need"} a look before Canvas.${skipped ? ` ${skipped} skipped; their text is unverified.` : ""}`;
  if (skipped) return `Review finished: ${skipped} ${skipped === 1 ? "region" : "regions"} skipped; their text is unverified.`;
  return "Draft ready. Nothing left to review.";
}
