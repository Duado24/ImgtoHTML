/** Terminal screenshots: which lines are commands (after a prompt), which
 *  are output and which are errors, so prompts and errors get the theme's
 *  colors. */

import { sameColor } from "./colors";
import { lineText, type PaintedLine, type Run } from "./paint";
import type { Theme } from "./theme";

export type LineRole = "command" | "output" | "error";

export interface TerminalLine {
  role: LineRole;
  /** The prompt at the start of a command line ("user@host:~$ "), else "". */
  prompt: string;
}

/** Prompts in the order they're tried. Each must end where the command starts. */
const PROMPTS = [
  /^[\w.-]+@[\w.-]+:[^\s$#]*\s?[$#]\s/, // user@host:~/dir$  pi@raspberrypi:~ $
  /^PS [A-Za-z]:\\[^>]*>\s?/, // PS C:\Users\me>
  /^[A-Za-z]:\\[^>]*>\s?/, // C:\Users\me>
  /^\([\w.-]+\)\s+[\w.-]+@[\w.-]+:[^\s$#]*[$#]\s/, // (venv) user@host:~$
  /^[$#%]\s/, // $ ls
  /^>>>\s|^\.\.\.\s/, // Python REPL
];

const ERROR = /\b(error|fatal|failed|failure|denied|not found|no such file|exception|traceback|cannot|could not|unable to)\b/i;

export function classifyLine(text: string): TerminalLine {
  for (const pattern of PROMPTS) {
    const match = pattern.exec(text);
    // A prompt followed only by the cursor ("|", "_", "█") is an empty prompt, not a command.
    if (match && !/^[\s|_█▌▏]*$/.test(text.slice(match[0].length))) return { role: "command", prompt: match[0] };
  }
  return { role: ERROR.test(text) ? "error" : "output", prompt: "" };
}

/** Split runs so one starts exactly at `at` (a UTF-16 offset in the line). */
function splitAt(runs: readonly Run[], at: number): Run[] {
  const out: Run[] = [];
  let start = 0;
  for (const run of runs) {
    const end = start + run.text.length;
    if (at > start && at < end) {
      out.push({ ...run, text: run.text.slice(0, at - start) }, { ...run, text: run.text.slice(at - start) });
    } else out.push(run);
    start = end;
  }
  return out;
}

/** Give prompts (green) and error lines (red) the theme's colors where the
 *  screenshot showed them in the plain text color, as many terminals do. */
export function colorRoles(lines: readonly PaintedLine[], theme: Theme): PaintedLine[] {
  const plain = (r: Run) => !r.color || sameColor(r.color, theme.colors.text);
  return lines.map((line) => {
    const role = classifyLine(lineText(line));
    if (role.role === "error") return { ...line, runs: line.runs.map((r) => (plain(r) ? { ...r, color: theme.colors.red } : r)) };
    if (role.role !== "command") return line;
    let start = 0;
    const runs = splitAt(line.runs, role.prompt.length).map((r) => {
      const inPrompt = start < role.prompt.length;
      start += r.text.length;
      return inPrompt && plain(r) ? { ...r, color: theme.colors.green } : r;
    });
    return { ...line, runs };
  });
}
