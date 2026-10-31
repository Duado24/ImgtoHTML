/** Score AI reports against the known-correct text of their screenshots:
 *  how well the AI instructions (or the ChatGPT plugin) read screenshots.
 *
 *    npm run eval [-- --only <text>] [-- --allow-empty]
 *
 *  For every <name>.report.json in fixtures/ that has a <name>.txt beside it,
 *  the report's text (or the region that best matches the .txt, which may
 *  cover only the code) is scored: character errors and lines read exactly
 *  right, both ignoring spacing. Reports that fail the format check are
 *  listed with their problems. Screenshots aren't needed. */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreText, type TextScore } from "../src/core/metrics";
import { parseReport, reportText } from "../src/core/report";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const args = process.argv.slice(2);
const filter = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const found = existsSync(FIXTURES) ? await readdir(FIXTURES, { recursive: true, withFileTypes: true }) : [];
const reports = found
  .filter((d) => d.isFile() && d.name.endsWith(".report.json") && (!filter || d.name.includes(filter)))
  .map((d) => join(d.parentPath, d.name))
  .sort();

if (!reports.length) {
  // Course screenshots and their reports stay local (privacy), so a fresh checkout has none.
  if (args.includes("--allow-empty")) {
    console.log("SKIPPED: no reports in fixtures/, nothing was checked (--allow-empty).");
    process.exit(0);
  }
  console.error("No <name>.report.json files in fixtures/, so nothing was checked. See fixtures/README.md.");
  process.exit(1);
}

const rows: { file: string; kind: string; score: TextScore }[] = [];
let invalid = 0;
for (const path of reports) {
  const file = relative(FIXTURES, path).split(sep).join("/");
  const parsed = parseReport(await readFile(path, "utf8"));
  if (!parsed.ok) {
    invalid++;
    console.log(`INVALID ${file}\n  ${parsed.problems.join("\n  ")}`);
    continue;
  }
  const txt = path.replace(/\.report\.json$/, ".txt");
  if (!existsSync(txt)) continue;
  const expected = await readFile(txt, "utf8");
  let score = scoreText(expected, reportText(parsed.report));
  for (const region of parsed.report.regions) {
    const own = scoreText(expected, region.lines.join("\n"));
    if (own.cerIgnoringSpaces < score.cerIgnoringSpaces) score = own;
  }
  rows.push({ file, kind: parsed.report.kind, score });
}

console.table(rows.map((r) => ({
  file: r.file, kind: r.kind,
  "errors (no spaces)": pct(r.score.cerIgnoringSpaces),
  "lines right (no spaces)": pct(r.score.lineAccuracyIgnoringSpaces),
  "lines exact": pct(r.score.lineAccuracy),
})));
for (const kind of [...new Set(rows.map((r) => r.kind))].sort()) {
  const group = rows.filter((r) => r.kind === kind);
  const mean = (f: (s: TextScore) => number) => pct(group.reduce((s, r) => s + f(r.score), 0) / group.length);
  console.log(`${kind} (${group.length}): errors ${mean((s) => s.cerIgnoringSpaces)}, lines right ${mean((s) => s.lineAccuracyIgnoringSpaces)} (ignoring spaces)`);
}
console.log(`${rows.length} reports scored against their .txt; ${reports.length - rows.length - invalid} without a .txt; ${invalid} invalid.`);
if (invalid) process.exitCode = 1;
