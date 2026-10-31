import { describe, expect, it } from "vitest";
import { detectLanguage, highlightClipped, highlightCode, supportedLanguage } from "../src/core/code";
import { lineText } from "../src/core/paint";
import { CODE_THEME } from "../src/core/theme";

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

describe("highlighting lines cut off at the screenshot edge", () => {
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

describe("supportedLanguage", () => {
  it("maps the names AIs and people use to the highlighted languages", () => {
    expect(supportedLanguage("Python")).toBe("python");
    expect(supportedLanguage("JS")).toBe("javascript");
    expect(supportedLanguage("C#")).toBe("csharp");
    expect(supportedLanguage("yml")).toBe("yaml");
    expect(supportedLanguage("html")).toBe("xml");
    expect(supportedLanguage("cobol")).toBeNull();
    expect(supportedLanguage(undefined)).toBeNull();
  });
});
