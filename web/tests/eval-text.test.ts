import { expect, it } from "vitest";
import { cutOffTokens, withoutCutOffAnnotations } from "../scripts/eval-text";
import { scoreText, unsupportedWords } from "../src/core/metrics";

it("excludes only the marker appended to a recorded cut-off line", () => {
  const cutOff = [{ text: '  "description": "TypeScript client and Nod' }];
  const actual = '  "description": "TypeScript client and Nod…\nOther…\nNod…';
  expect(withoutCutOffAnnotations(actual, cutOff)).toBe('  "description": "TypeScript client and Nod\nOther…\nNod…');
  expect(scoreText(cutOff[0]!.text, withoutCutOffAnnotations(actual.split("\n")[0]!, cutOff)).cer).toBe(0);
  expect(withoutCutOffAnnotations('"description": "TypeScript client and Node…', cutOff)).toContain("Node…");
});

it("preserves ellipses and punctuation already present in the screenshot", () => {
  const cutOff = [{ text: "Loading…" }, { text: "Wait..." }];
  expect(withoutCutOffAnnotations("Loading…\nWait...", cutOff)).toBe("Loading…\nWait...");
  expect(cutOffTokens(cutOff)).toEqual([]);
});

it("supports the observed token with its marker while detecting invented completions", () => {
  const cutOff = [{ text: "TypeScript client and Nod" }];
  expect(cutOffTokens(cutOff)).toEqual(["Nod…"]);
  expect(unsupportedWords("<div>Nod… Node.js server</div>", ["Nod", ...cutOffTokens(cutOff)]))
    .toEqual(["Node.js", "server"]);
});
