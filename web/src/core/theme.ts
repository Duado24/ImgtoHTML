/** Standard course themes. Terminals and code use these fixed colors
 *  instead of each screenshot's own, so every code block in a course looks
 *  the same and its contrast is checked once, here (tests/theme.test.ts). */

import type { Kind, RGB } from "./types";

export const SLOTS = ["text", "dim", "red", "yellow", "green", "cyan", "blue", "magenta", "sky"] as const;
export type Slot = (typeof SLOTS)[number];

export interface Theme {
  name: string;
  background: RGB;
  /** Background for highlighted words and lines (selection, active item). */
  highlight: RGB;
  colors: Record<Slot, RGB>;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** VS Code Dark+ integrated terminal (bright ANSI colors). */
export const TERMINAL_THEME: Theme = {
  name: "vscode-dark-terminal",
  background: hex("#1e1e1e"),
  highlight: hex("#252526"),
  colors: {
    text: hex("#cccccc"),
    dim: hex("#8f8f8f"),
    red: hex("#f25858"), // VS Code #f14c4c is 4.3:1; lightened to pass
    yellow: hex("#f5f543"),
    green: hex("#23d18b"),
    cyan: hex("#29b8db"),
    blue: hex("#3b8eea"),
    magenta: hex("#d670d6"),
    sky: hex("#9cdcfe"), // light blue; only syntax highlighting uses it
  },
};

/** VS Code Dark+ editor syntax colors. */
export const CODE_THEME: Theme = {
  name: "vscode-dark-code",
  background: hex("#1e1e1e"),
  highlight: hex("#252526"),
  colors: {
    text: hex("#d4d4d4"),
    dim: hex("#8f8f8f"),
    red: hex("#ce9178"), // strings
    yellow: hex("#dcdcaa"), // functions
    green: hex("#6a9955"), // comments
    cyan: hex("#4ec9b0"), // types
    blue: hex("#569cd6"), // keywords
    magenta: hex("#c586c0"), // control flow
    sky: hex("#9cdcfe"), // variables, properties, JSON keys
  },
};

/** The theme a kind of screenshot uses; null: the report's own colors. */
export function themeFor(kind: Kind): Theme | null {
  return kind === "terminal" ? TERMINAL_THEME : kind === "code" ? CODE_THEME : null;
}

