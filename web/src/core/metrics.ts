/** How close a transcript is to the known-correct text. Used by the test-set
 *  evaluation (scripts/eval.ts) to compare converter versions. */

/** Characters OCR mixes up that change what a command or code line does. */
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

interface Placed {
  type: string;
  box: { x: number; y: number; width: number; height: number };
}

export interface LayoutScore {
  /** Mean over the hand-marked components (1 = every box exact, 0 = none found). */
  meanIoU: number;
  /** Per marked component: the best overlap (intersection over union) with a detected one of the same type. */
  components: { type: string; iou: number }[];
}

const iou = (a: Placed["box"], b: Placed["box"]) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
};

/** How well detected components match hand-marked ones (a `.layout.json`
 *  next to a test screenshot). No layout detected scores 0 everywhere. */
export function scoreLayout(detected: readonly Placed[] | null | undefined, marked: readonly Placed[]): LayoutScore {
  const components = marked.map((m) => ({
    type: m.type,
    iou: Math.max(0, ...(detected ?? []).filter((d) => d.type === m.type).map((d) => iou(d.box, m.box))),
  }));
  return { meanIoU: components.reduce((s, c) => s + c.iou, 0) / Math.max(1, components.length), components };
}

/** Tags that separate words when the page is read; other tags (spans) join their text. */
const BLOCK = /<\/?(?:div|td|th|tr|table|tbody|thead|p|br|li|ul|ol|h[1-6]|figure|figcaption|section)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Named entities above, and numeric ones (&#39; &#x27;). */
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? whole);
/** Quote style and doubled quotes are clean-up, not new text. */
const wordKey = (w: string) => w.replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'").replace(/(["'])\1+/g, "$1");

/** Visible words of `html` (words with a letter in them) that none of the
 *  `supported` words backs up: text the converter made up. Punctuation-only
 *  tokens (repaired braces, drawn arrows) and numbers (renumbered gutters)
 *  aren't counted. Quote style and doubled quotes are ignored. */
export function unsupportedWords(html: string, supported: Iterable<string>): string[] {
  const known = new Set([...supported].flatMap((s) => s.split(/\s+/)).map(wordKey));
  const text = decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(BLOCK, " ").replace(/<[^>]+>/g, ""));
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w) && !known.has(wordKey(w)));
}
