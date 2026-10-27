import { describe, expect, it } from "vitest";
import { contrast } from "../src/core/colors";
import { applyTheme, CODE_THEME, SLOTS, slotFor, TERMINAL_THEME } from "../src/core/theme";
import type { RGB } from "../src/core/types";

describe("course themes", () => {
  for (const theme of [TERMINAL_THEME, CODE_THEME]) {
    it(`${theme.name}: every color reaches 4.5:1 on the background and on highlights`, () => {
      for (const slot of SLOTS) {
        for (const bg of [theme.background, theme.highlight]) {
          expect(contrast(theme.colors[slot], bg), `${slot}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

describe("slotFor", () => {
  const bg: RGB = [30, 30, 30];
  const text: RGB = [204, 204, 204];

  it("maps colors by hue, as VS Code Dark+ draws them", () => {
    expect(slotFor([206, 145, 120], text, bg)).toBe("red"); // string (orange-red)
    expect(slotFor([220, 220, 170], text, bg)).toBe("yellow"); // function
    expect(slotFor([106, 153, 85], text, bg)).toBe("green"); // comment
    expect(slotFor([78, 201, 176], text, bg)).toBe("cyan"); // type
    expect(slotFor([86, 156, 214], text, bg)).toBe("blue"); // keyword
    expect(slotFor([197, 134, 192], text, bg)).toBe("magenta"); // control flow
  });

  it("keeps grays as main text or dim text", () => {
    expect(slotFor([212, 212, 212], text, bg)).toBe("text");
    expect(slotFor([255, 255, 255], text, bg)).toBe("text");
    expect(slotFor([110, 110, 110], text, bg)).toBe("dim");
  });
});

describe("applyTheme", () => {
  it("swaps colors and highlights for the theme's", () => {
    const lines = applyTheme(
      [{ background: [9, 71, 113], runs: [{ text: "$ ", color: [13, 188, 121] }, { text: "ls", background: [50, 50, 50] }, { text: " x" }] }],
      TERMINAL_THEME,
      [204, 204, 204],
      [30, 30, 30],
    );
    expect(lines).toEqual([
      {
        background: TERMINAL_THEME.highlight,
        runs: [
          { text: "$ ", color: TERMINAL_THEME.colors.green },
          { text: "ls", background: TERMINAL_THEME.highlight },
          { text: " x" },
        ],
      },
    ]);
  });
});
