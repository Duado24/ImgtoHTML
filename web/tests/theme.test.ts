import { describe, expect, it } from "vitest";
import { contrast } from "../src/core/colors";
import { CODE_THEME, SLOTS, TERMINAL_THEME, themeFor } from "../src/core/theme";

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

describe("themeFor", () => {
  it("gives terminals and code the course themes; other kinds use the report's colors", () => {
    expect(themeFor("terminal")).toBe(TERMINAL_THEME);
    expect(themeFor("code")).toBe(CODE_THEME);
    expect(themeFor("interface")).toBeNull();
  });
});
