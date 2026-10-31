import { describe, expect, it } from "vitest";
import { AI_INSTRUCTIONS } from "../src/core/prompt";
import { APPLICATIONS, COMPONENTS, parseReport } from "../src/core/report";
import { KINDS } from "../src/core/types";

describe("the AI instructions", () => {
  it("contain an example report that the app accepts", () => {
    const example = AI_INSTRUCTIONS.slice(AI_INSTRUCTIONS.indexOf("{"), AI_INSTRUCTIONS.indexOf("\n}\n") + 2);
    const parsed = parseReport(example);
    expect(parsed.ok ? [] : parsed.problems).toEqual([]);
  });

  it("list every kind, application and region type the app accepts", () => {
    for (const word of [...KINDS, ...APPLICATIONS, ...COMPONENTS]) expect(AI_INSTRUCTIONS).toContain(word);
  });

  it("keep the rules that protect the text", () => {
    expect(AI_INSTRUCTIONS).toContain("Never fix, finish or improve anything");
    expect(AI_INSTRUCTIONS).toContain("Never complete it");
    expect(AI_INSTRUCTIONS).toContain("Never guess it");
  });

  it("fit in a custom GPT's instructions (8,000 characters)", () => {
    expect(AI_INSTRUCTIONS.length).toBeLessThan(8000);
  });
});
