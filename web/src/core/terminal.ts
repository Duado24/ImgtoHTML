/** Terminal screenshots: which lines are commands (after a prompt), which
 *  are output, which are errors, and which OCR readings of a command are
 *  probably lookalike mistakes. Suggestions are never applied on their
 *  own; they go to review. */

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

export interface Suggestion {
  /** As OCR read it. */
  from: string;
  to: string;
  why: string;
}

/** Commands that course screenshots run; used to spot "1s" for "ls". */
const COMMANDS = new Set([
  "ls", "ll", "cd", "pwd", "cat", "less", "head", "tail", "mkdir", "rmdir", "rm", "cp", "mv", "touch", "chmod",
  "chown", "ln", "find", "grep", "echo", "clear", "exit", "nano", "vim", "sudo", "apt", "apt-get", "pip", "pip3",
  "python", "python3", "node", "npm", "npx", "git", "ssh", "scp", "ping", "curl", "wget", "man", "which", "whoami",
  "history", "ps", "kill", "top", "htop", "df", "du", "tar", "unzip", "zip", "neofetch", "ifconfig", "ip",
  "systemctl", "reboot", "shutdown", "dir", "cls", "type", "del", "copy", "move", "code", "docker", "java", "javac",
  "gcc", "make", "dotnet",
]);

/** Likely OCR mistakes in one word of a command. `first`: the command name itself. */
export function suggestFix(word: string, first: boolean): Suggestion | null {
  if (first && !COMMANDS.has(word) && /[1I|]/.test(word)) {
    const fixed = word.replace(/[1I|]/g, "l");
    if (COMMANDS.has(fixed)) return { from: word, to: fixed, why: `"${fixed}" is a command; "${word}" is not` };
  }
  if (/^—[\w-]/.test(word)) return { from: word, to: "--" + word.slice(1), why: "a long dash before an option is usually --" };
  if (/^–[\w-]/.test(word)) return { from: word, to: "-" + word.slice(1), why: "an en dash before an option is usually -" };
  if (/[‘’“”]/.test(word)) {
    return { from: word, to: word.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'), why: "terminals use straight quotes" };
  }
  return null;
}

/** Suggestions for every word after the prompt of a command line. */
export function suggestFixes(text: string): Suggestion[] {
  const { role, prompt } = classifyLine(text);
  if (role !== "command") return [];
  return text
    .slice(prompt.length)
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => suggestFix(word, i === 0))
    .filter((s): s is Suggestion => s !== null);
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
