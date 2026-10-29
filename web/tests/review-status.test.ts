import { expect, it } from "vitest";
import { reviewCounts, reviewReadyText } from "../src/browser/review-status";
import type { ModelRegion, ReviewState } from "../src/core/model";

const regions = (...states: ReviewState[]) => states.map((review) => ({ review, flags: [{}] }) as ModelRegion);

it("counts each flagged review state and ignores unflagged regions", () => {
  expect(reviewCounts([...regions("pending", "approved", "corrected", "skipped"), { review: "pending", flags: [] } as unknown as ModelRegion]))
    .toEqual({ pending: 1, approved: 1, corrected: 1, skipped: 1 });
});

it("never calls skipped text verified or nothing left to review", () => {
  expect(reviewReadyText(regions("skipped", "approved"))).toBe("Review finished: 1 region skipped; their text is unverified.");
  expect(reviewReadyText(regions("pending", "skipped"))).toContain("1 skipped; their text is unverified.");
  expect(reviewReadyText(regions("pending"))).toContain("1 region needs");
  expect(reviewReadyText(regions("approved", "corrected"))).toContain("Nothing left to review");
  expect(reviewReadyText([])).toContain("Nothing left to review");
});
