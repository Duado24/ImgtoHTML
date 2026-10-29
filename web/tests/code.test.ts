import { describe, expect, it } from "vitest";
import { cleanCode, detectLanguage, highlightCode, measuredTheme } from "../src/core/code";
import { lineText } from "../src/core/paint";
import { CODE_THEME } from "../src/core/theme";
import { highlightClipped, letterInk } from "../src/core/convert";

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
    const { theme, measured } = measuredTheme(rows, "json", CODE_THEME, (w) => [ink(w)]);
    expect(measured).toEqual(expect.arrayContaining(["sky", "red"]));
    expect(theme.colors.sky).toEqual(green);
    expect(theme.colors.red).toEqual(blue);
    expect(theme.colors.magenta).toEqual(CODE_THEME.colors.magenta);
  });
  it("measures a letter's hue from all its ink and its strength from the core", () => {
    // One 4×1 letter on black: two pale core pixels, two dimmer, bluer edge pixels.
    const core = [181, 213, 251], edge = [66, 100, 140];
    const data = new Uint8ClampedArray([...edge, 255, ...core, 255, ...core, 255, ...edge, 255]);
    const word = { text: "a", x: 0, y: 0, width: 4, height: 1, confidence: 99, block: 0, paragraph: 0, line: 0 };
    const [color] = letterInk({ width: 4, height: 1, data }, word, 0, [0, 0, 0]);
    expect(color).toEqual([168, 212, 255]); // bluer than the core, as strong
    expect(letterInk({ width: 4, height: 1, data: new Uint8ClampedArray(16) }, word, 0, [0, 0, 0])).toEqual([]);
  });
  it("keeps the theme's color without enough letters to measure", () => {
    const { measured } = measuredTheme([[{ text: '"a":' }]], "json", CODE_THEME, (w) => [ink(w)]);
    expect(measured).not.toContain("sky");
  });
});

describe("highlighting lines cut off at the panel edge", () => {
  const lines = ['{', '  "description": "Local screenshot to Canvas HTML app, with a TypeScript client and Nod', '  "type": "module",', '}'];
  const keyColor = (painted: ReturnType<typeof highlightClipped>, i: number) => painted[i]!.runs.find((r) => r.text.includes('"type"'))?.color;

  it("keeps later keys colored as keys after a cut-off string", () => {
    const painted = highlightClipped(lines, [false, true, false, false], "json", CODE_THEME);
    expect(keyColor(painted, 2)).toEqual(CODE_THEME.colors.sky);
    expect(painted[1]!.runs.map((r) => r.text).join("")).toBe(lines[1]); // no quote added to the text
  });
  it("without knowing the line is cut off, the string runs on (why this exists)", () => {
    expect(keyColor(highlightClipped(lines, [], "json", CODE_THEME), 2)).not.toEqual(CODE_THEME.colors.sky);
  });
});
