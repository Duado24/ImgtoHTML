import { describe, expect, it } from "vitest";
import { normalize, scoreText } from "../src/core/metrics";

describe("scoreText", () => {
  it("scores an exact match as perfect, ignoring trailing spaces and line endings", () => {
    expect(scoreText("ls -la\r\n  total 8  \r\n\r\n", "ls -la\n  total 8")).toEqual({
      cer: 0,
      cerIgnoringSpaces: 0,
      lineAccuracy: 1,
      lineAccuracyIgnoringSpaces: 1,
      confusable: [],
    });
  });

  it("separates spacing errors from letter errors", () => {
    const score = scoreText("a  b", "a b");
    expect(score.cer).toBeCloseTo(1 / 4);
    expect(score.cerIgnoringSpaces).toBe(0);
  });

  it("treats indentation, column gaps and blank lines as spacing", () => {
    const score = scoreText("OS Customisation\nGENERAL  SERVICES\nSAVE", "   OS Customisation\n\n\n  GENERAL        SERVICES\n\n          SAVE");
    expect(score.cer).toBeGreaterThan(0.5);
    expect(score.cerIgnoringSpaces).toBe(0);
    expect(score.lineAccuracy).toBe(0);
    expect(score.lineAccuracyIgnoringSpaces).toBe(1);
  });

  it("lists confusable-character edits", () => {
    const score = scoreText("ls -l\necho 'hi'", "1s —l\necho `hi'");
    expect(score.confusable).toEqual(["l→1", "-→—", "'→`"]);
    expect(score.lineAccuracy).toBe(0);
  });

  it("keeps indentation", () => {
    expect(normalize("def f():\n    return 1\n")).toBe("def f():\n    return 1");
  });
});

