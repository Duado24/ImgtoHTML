/** How close a report's text is to the known-correct text of a screenshot:
 *  the score that tells whether the AI instructions read screenshots well
 *  (scripts/eval.ts). */

/** Characters that are easy to misread and change what a command or code line does. */
export const CONFUSABLE = new Set([..."lI1|i!oO0'\"`‘’“”-–—~,.:;5S8B2Z"]);

/** CRLF → LF, no trailing spaces, no trailing blank lines. Indentation stays. */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "");
}

/** Every run of spaces as one space, no indentation, no blank lines: separates
 *  layout spacing (which renderers keep as in the screenshot, and expected .txt
 *  files usually compact) from letter errors. */
const collapse = (text: string) =>
  text.replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

export interface TextScore {
  /** Edits needed per expected character (0 = exact). */
  cer: number;
  /** Same, ignoring how many spaces there are, indentation and blank lines. */
  cerIgnoringSpaces: number;
  /** Share of expected lines found word for word in the output. */
  lineAccuracy: number;
  /** Same, ignoring how many spaces there are and indentation. */
  lineAccuracyIgnoringSpaces: number;
  /** Edits involving a confusable character, e.g. "l→1"; null when too long to align. */
  confusable: string[] | null;
}

const MAX_CELLS = 25_000_000;

/** Edit distance, plus the edits themselves when the texts are short enough. */
function edits(a: readonly string[], b: readonly string[]): { distance: number; ops: string[] | null } {
  const n = a.length;
  const m = b.length;
  const keep = (n + 1) * (m + 1) <= MAX_CELLS;
  // 0 = match/substitute (diagonal), 1 = deletion (up), 2 = insertion (left)
  const moves = keep ? new Uint8Array((n + 1) * (m + 1)) : null;
  let previous = Array.from({ length: m + 1 }, (_, j) => j);
  if (moves) for (let j = 1; j <= m; j++) moves[j] = 2;
  for (let i = 1; i <= n; i++) {
    const current = [i];
    if (moves) moves[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const diagonal = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const up = previous[j]! + 1;
      const left = current[j - 1]! + 1;
      const best = Math.min(diagonal, up, left);
      current.push(best);
      if (moves) moves[i * (m + 1) + j] = best === diagonal ? 0 : best === up ? 1 : 2;
    }
    previous = current;
  }
  const distance = previous[m]!;
  if (!moves) return { distance, ops: null };

  const ops: string[] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const move = moves[i * (m + 1) + j];
    if (move === 0) {
      if (a[i - 1] !== b[j - 1]) ops.push(`${a[i - 1]}→${b[j - 1]}`);
      i--, j--;
    } else if (move === 1) ops.push(`${a[--i]}→∅`);
    else ops.push(`∅→${b[--j]}`);
  }
  return { distance, ops: ops.reverse() };
}

const show = (c: string) => (c === "\n" ? "⏎" : c === " " ? "␠" : c);

export function scoreText(expected: string, actual: string): TextScore {
  const want = normalize(expected);
  const got = normalize(actual);
  const exact = edits([...want], [...got]);
  const loose = edits([...collapse(want)], [...collapse(got)]);
  const lines = want.split("\n").filter((l) => l.trim());
  const found = new Set(got.split("\n"));
  const looseFound = new Set(collapse(got).split("\n"));
  const per = (d: number, length: number) => (length ? d / length : d ? 1 : 0);
  const share = (hit: (line: string) => boolean) => (lines.length ? lines.filter(hit).length / lines.length : 1);
  return {
    cer: per(exact.distance, [...want].length),
    cerIgnoringSpaces: per(loose.distance, [...collapse(want)].length),
    lineAccuracy: share((l) => found.has(l)),
    lineAccuracyIgnoringSpaces: share((l) => looseFound.has(collapse(l))),
    confusable:
      loose.ops?.filter((op) => [...op.replace("→", "")].some((c) => CONFUSABLE.has(c))).map((op) => [...op].map(show).join("")) ??
      null,
  };
}

