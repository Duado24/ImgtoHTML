import { describe, expect, it } from "vitest";
import { classifyLine, colorRoles } from "../src/core/terminal";
import { TERMINAL_THEME } from "../src/core/theme";

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

  it("keeps colors a line already has", () => {
    const blue = TERMINAL_THEME.colors.blue;
    expect(colorRoles([{ runs: [{ text: "$ ls", color: blue }] }], TERMINAL_THEME)[0]!.runs).toEqual([
      { text: "$ ", color: blue },
      { text: "ls", color: blue },
    ]);
  });
});

