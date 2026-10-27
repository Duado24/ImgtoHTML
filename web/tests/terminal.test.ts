import { describe, expect, it } from "vitest";
import { buildModel } from "../src/core/model";
import { classifyLine, colorRoles, suggestFixes } from "../src/core/terminal";
import { TERMINAL_THEME } from "../src/core/theme";
import type { OcrWord } from "../src/core/types";

describe("classifyLine", () => {
  it.each([
    ["user@host:~/repo$ git status", "user@host:~/repo$ "],
    ["pi@raspberrypi:~ $ ls -la", "pi@raspberrypi:~ $ "],
    ["(venv) me@box:~$ pip install x", "(venv) me@box:~$ "],
    ["PS C:\\Users\\username> git log", "PS C:\\Users\\username> "],
    ["C:\\Users\\username>dir", "C:\\Users\\username>"],
    ["$ echo hi", "$ "],
    [">>> print(1)", ">>> "],
  ])("finds the prompt in %s", (line, prompt) => {
    expect(classifyLine(line)).toEqual({ role: "command", prompt });
  });

  it("tells output from errors", () => {
    expect(classifyLine("total 8").role).toBe("output");
    expect(classifyLine("fatal: not a git repository").role).toBe("error");
    expect(classifyLine("bash: foo: command not found").role).toBe("error");
  });

  it("does not treat a bare prompt or a cursor as a command", () => {
    expect(classifyLine("user@host:~$ ").role).toBe("output");
    expect(classifyLine("PS C:\\Users\\username> |").role).toBe("output");
  });
});

describe("suggestFixes", () => {
  it("suggests the command a lookalike reading stands for", () => {
    expect(suggestFixes("$ 1s -la").map((s) => s.to)).toEqual(["ls"]);
    expect(suggestFixes("$ Is").map((s) => s.to)).toEqual(["ls"]);
  });

  it("suggests ASCII dashes and quotes in commands", () => {
    expect(suggestFixes("$ git log —oneline").map((s) => s.to)).toEqual(["--oneline"]);
    expect(suggestFixes("$ echo “hi”").map((s) => s.to)).toEqual(['"hi"']);
  });

  it("leaves output and correct commands alone", () => {
    expect(suggestFixes("1s —oneline “hi”")).toEqual([]);
    expect(suggestFixes("$ ls -la")).toEqual([]);
    expect(suggestFixes("$ I18n")).toEqual([]);
  });
});

describe("colorRoles", () => {
  const { text, green, red } = TERMINAL_THEME.colors;

  it("colors plain prompts green and plain error lines red", () => {
    const lines = colorRoles(
      [{ runs: [{ text: "$ ls", color: text }] }, { runs: [{ text: "fatal: oops", color: text }] }, { runs: [{ text: "ok" }] }],
      TERMINAL_THEME,
    );
    expect(lines).toEqual([
      { runs: [{ text: "$ ", color: green }, { text: "ls", color: text }] },
      { runs: [{ text: "fatal: oops", color: red }] },
      { runs: [{ text: "ok" }] },
    ]);
  });

  it("keeps colors the screenshot already had", () => {
    const blue = TERMINAL_THEME.colors.blue;
    expect(colorRoles([{ runs: [{ text: "$ ls", color: blue }] }], TERMINAL_THEME)[0]!.runs).toEqual([
      { text: "$ ", color: blue },
      { text: "ls", color: blue },
    ]);
  });
});

describe("terminal model", () => {
  const word = (text: string, x: number): OcrWord => ({
    text, x, y: 0, width: 10 * text.length, height: 12, confidence: 95, block: 1, paragraph: 1, line: 1,
  });

  it("records roles, prompts and suggested fixes for review", () => {
    const words = [word("$", 0), word("1s", 20), word("-la", 50)];
    const tree = { kind: "leaf" as const, box: { x: 0, y: 0, width: 200, height: 20 }, background: [0, 0, 0] as const, words };
    const [region] = buildModel(200, 20, "terminal", tree, words).regions;
    const line = region!.lines[0]!;
    expect(line).toMatchObject({ role: "command", prompt: "$ " });
    expect(line.spans[1]!.alternatives).toEqual([{ source: "rule", text: "ls", confidence: null }]);
    expect(region!.flags.map((f) => f.reason)).toContain("suggested-fix");
  });
});
