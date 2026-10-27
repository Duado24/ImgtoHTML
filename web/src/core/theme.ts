/** Standard course themes. Terminals and code use these fixed colors
 *  instead of each screenshot's own, so every code block in a course looks
 *  the same and its contrast is checked once, here (tests/theme.test.ts).
 *
 *  Measured colors still matter: each one is mapped to the theme's color
 *  of the same kind (a green prompt stays green, a red error stays red,
 *  gray comments stay dimmer than the main text). */

import { contrast, rgbToHls } from "./colors";
import type { PaintedLine } from "./paint";
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

/** The theme a kind of screenshot uses; null keeps the screenshot's colors. */
export function themeFor(kind: Kind): Theme | null {
  return kind === "terminal" ? TERMINAL_THEME : kind === "code" ? CODE_THEME : null;
}

/** Hue (degrees) at the center of each colored slot. Green and cyan sit
 *  apart so terminal greens (#0dbc79, hue 156) stay green. */
const HUES: [Slot, number][] = [["red", 0], ["yellow", 50], ["green", 130], ["cyan", 190], ["blue", 222], ["magenta", 290], ["red", 360]];
/** Below this saturation, a color counts as gray. */
const GRAY = 0.2;
/** A gray with less than this share of the main text's contrast is "dim". */
const DIM = 0.65;

/** Which theme color a measured text color stands for. */
export function slotFor(color: RGB, mainText: RGB, background: RGB): Slot {
  const [h, l, s] = rgbToHls(color[0] / 255, color[1] / 255, color[2] / 255);
  if (s < GRAY || l > 0.93 || l < 0.07) {
    return contrast(color, background) < DIM * contrast(mainText, background) ? "dim" : "text";
  }
  const hue = h * 360;
  return HUES.reduce((best, entry) => (Math.abs(entry[1] - hue) < Math.abs(best[1] - hue) ? entry : best))[0];
}

/** Replace measured colors with the theme's. `mainText` and `background`
 *  are the screenshot's own, measured, so "dim" is judged as it looked. */
export function applyTheme(lines: readonly PaintedLine[], theme: Theme, mainText: RGB, background: RGB): PaintedLine[] {
  const color = (c: RGB | undefined) => (c ? theme.colors[slotFor(c, mainText, background)] : undefined);
  return lines.map((line) => ({
    ...(line.background ? { background: theme.highlight } : {}),
    runs: line.runs.map((run) => ({
      text: run.text,
      ...(run.color ? { color: color(run.color) } : {}),
      ...(run.background ? { background: theme.highlight } : {}),
    })),
  }));
}
