import { describe, expect, it } from "vitest";
import { cleanCode, detectLanguage, highlightCode, measuredTheme } from "../src/core/code";
import { lineText } from "../src/core/paint";
import { CODE_THEME } from "../src/core/theme";

describe("cleanCode", () => {
  it("removes gutter line numbers and keeps indentation after them", () => {
    const out = cleanCode(["1  def f(x):", "2      if x:", "3          return 1", "4      return 0"]);
    expect(out.lineNumbersRemoved).toBe(true);
    expect(out.lines).toEqual(["def f(x):", "    if x:", "        return 1", "    return 0"]);
  });

  it("handles a real VS Code screenshot: tabs above, misread numbers, stray marks", () => {
    const out = cleanCode([
      "  [Preview] README.md   app.py 1, M",
      "® app.py >...",
      "  1    import time",
      "  2    x = 1",
      "  3",
      "  Bf   while True:",
      "  9        if x:",
      "  10           print(x)",
      "  11 |         x = 0",
      "  i.",
      "  13       time.sleep(1)",
    ]);
    expect(out).toMatchObject({ lineNumbersRemoved: true, linesOutsideCode: 2 });
    expect(out.lines).toEqual(["import time", "x = 1", "", "while True:", "    if x:", "        print(x)", "        x = 0", "", "    time.sleep(1)"]);
  });

  it("drops editor hints between consecutive line numbers and straightens curly quotes", () => {
    const out = cleanCode(["  5    “type”: “module”,", "       Debug", "  6    “scripts”: {", "  7      “app”: ‘x’", "  8    }"]);
    expect(out).toMatchObject({ linesOutsideCode: 1, quotesStraightened: 3 });
    expect(out.lines).toEqual(['"type": "module",', '"scripts": {', `  "app": 'x'`, "}"]);
  });

  it("leaves numbers that are code, not a gutter", () => {
    const out = cleanCode(["x = 1", "10 + 5", "print(x)"]);
    expect(out.lineNumbersRemoved).toBe(false);
    expect(out.lines).toEqual(["x = 1", "10 + 5", "print(x)"]);
  });

  it("snaps indentation that is one space off the common step", () => {
    const out = cleanCode(["for i in range(3):", "     print(i)", "    if i:", "        break", "       pass"]);
    expect(out.indentUnit).toBe(4);
    expect(out.linesSnapped).toBe(2);
    expect(out.lines).toEqual(["for i in range(3):", "    print(i)", "    if i:", "        break", "        pass"]);
  });

  it("removes a shared left margin and blank-line spaces", () => {
    expect(cleanCode(["  a = 1", "   ", "  b = 2"]).lines).toEqual(["a = 1", "", "b = 2"]);
  });
});

describe("detectLanguage", () => {
  it.each([
    ["python", "def main():\n    for i in range(10):\n        print(f'{i}')\n\nif __name__ == '__main__':\n    main()"],
    ["java", "public class Main {\n    public static void main(String[] args) {\n        System.out.println(\"Hi\");\n    }\n}"],
    ["json", 't\n  "name": "web",\n  "private": true,\n  "scripts": {\n    "app": "bash start.sh"\n  },\nb'],
    ["javascript", "const items = [1, 2];\nfunction total(list) {\n  return list.reduce((a, b) => a + b, 0);\n}\nconsole.log(total(items));"],
  ])("recognizes %s", (language, code) => {
    expect(detectLanguage(code)).toBe(language);
  });

  it("returns null for plain text", () => {
    expect(detectLanguage("hello there")).toBeNull();
  });
});

describe("highlightCode", () => {
  it("keeps every line and character, colored with the theme", () => {
    const code = "def f():\n\n    return 'x'  # done";
    const lines = highlightCode(code, "python", CODE_THEME);
    expect(lines.map(lineText)).toEqual(["def f():", "", "    return 'x'  # done"]);
    const colors = lines.flatMap((l) => l.runs).filter((r) => r.color).map((r) => [r.text, r.color]);
    expect(colors).toEqual(expect.arrayContaining([
      ["def", CODE_THEME.colors.blue],
      ["f", CODE_THEME.colors.yellow],
      ["'x'", CODE_THEME.colors.red],
      ["# done", CODE_THEME.colors.green],
    ]));
  });

  it("escapes nothing twice when there is no language", () => {
    expect(highlightCode("a < b && c", null, CODE_THEME).map(lineText)).toEqual(["a < b && c"]);
  });
});

describe("measuredTheme", () => {
  const green: [number, number, number] = [92, 215, 146], blue: [number, number, number] = [66, 155, 236];
  const rows = [[{ text: '"name":' }, { text: '"imgtohtml-web",' }], [{ text: '"version":' }, { text: '"2.0.0",' }]];
  // Keys painted green, values blue: some editor theme other than Dark+.
  const ink = (w: { text: string }) => (w.text.endsWith(":") ? green : blue);

  it("takes each kind of token's color from the screenshot", () => {
    const { theme, measured } = measuredTheme(rows, "json", CODE_THEME, (w) => ink(w));
    expect(measured).toEqual(expect.arrayContaining(["sky", "red"]));
    expect(theme.colors.sky).toEqual(green);
    expect(theme.colors.red).toEqual(blue);
    expect(theme.colors.magenta).toEqual(CODE_THEME.colors.magenta);
  });
  it("keeps the theme's color without enough letters to measure", () => {
    const { measured } = measuredTheme([[{ text: '"a":' }]], "json", CODE_THEME, (w) => ink(w));
    expect(measured).not.toContain("sky");
  });
});
