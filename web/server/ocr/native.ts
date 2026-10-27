import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcrSymbol, OcrWord } from "../../src/core/types";
import type { OcrEngine, OcrImage } from "./engine";

export function parseTsv(tsv: string): OcrWord[] {
  return tsv.split(/\r?\n/).slice(1).flatMap((row) => {
    const cols = row.split("\t");
    if (cols[0] !== "5" || cols.length < 12) return [];
    const [block, paragraph, line, x, y, width, height, confidence] = [2, 3, 4, 6, 7, 8, 9, 10].map((i) => Number(cols[i]));
    const text = cols.slice(11).join("\t").trim();
    if (!text || ![block, paragraph, line, x, y, width, height, confidence].every(Number.isFinite)) return [];
    return [{ text, block: block!, paragraph: paragraph!, line: line!, x: x!, y: y!, width: width!, height: height!, confidence: confidence! }];
  });
}

/** makebox uses bottom-left coordinates; TSV and the core use top-left. */
export function withSymbols(words: OcrWord[], boxes: string, imageHeight: number): OcrWord[] {
  const symbols: OcrSymbol[] = boxes.split(/\r?\n/).flatMap((row) => {
    const m = /^(.*?) (\d+) (\d+) (\d+) (\d+) \d+$/.exec(row);
    if (!m) return [];
    return [{ text: m[1]!, x: +m[2]!, y: imageHeight - +m[5]!, width: +m[4]! - +m[2]!, height: +m[5]! - +m[3]! }];
  });
  return words.map((word) => ({
    ...word,
    symbols: symbols.filter((s) => {
      const x = s.x + s.width / 2, y = s.y + s.height / 2;
      return x >= word.x && x < word.x + word.width && y >= word.y && y < word.y + word.height;
    }),
  }));
}

export class NativeTesseract implements OcrEngine {
  constructor(private readonly executable = "tesseract", private readonly timeoutMs = 120_000) {}

  async recognize(image: OcrImage): Promise<OcrWord[]> {
    const directory = await mkdtemp(join(tmpdir(), "imgtohtml-"));
    try {
      const output = join(directory, "ocr");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable, ["stdin", output, "-l", "eng", "--oem", "1", "--psm", "6", "tsv", "makebox"], {
          shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, this.timeoutMs);
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(timedOut ? "Tesseract timed out." : `Tesseract failed (${code}): ${stderr.trim()}`));
        });
        // A failed/missing executable can close stdin before its error arrives.
        child.stdin.on("error", () => {});
        child.stdin.end(image.png);
      });
      const [tsv, boxes] = await Promise.all([readFile(`${output}.tsv`, "utf8"), readFile(`${output}.box`, "utf8")]);
      return withSymbols(parseTsv(tsv), boxes, image.height);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
