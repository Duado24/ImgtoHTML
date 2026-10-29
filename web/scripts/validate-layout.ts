import { OllamaVisionModel } from "../server/vision";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { decodeImage } from "../server/image";
import { LocalOcr } from "../server/ocr";
import { recognizeWords } from "../server/ocr/pipeline";
import { convert } from "../src/core/convert";
import { validateLayout } from "../src/core/vision-layout";
import { validateVisual } from "../server/visual-validation";
import { checkCanvasSafe } from "../src/core/canvas";

const image = await readFile('fixtures/code/vscode-package-json.png');
const decoded = await decodeImage(image, 'vscode.png');
if (process.argv.includes('--live')) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const body = await response.clone().json() as unknown;
    await mkdir('eval-results/layout', { recursive: true });
    await writeFile('eval-results/layout/model-response.json', JSON.stringify(body, null, 2));
    return response;
  };
}
const layout = process.argv.includes('--live') ? (await new OllamaVisionModel().detectLayout(decoded.pixels)).layout : validateLayout(JSON.parse(await readFile('tests/fixtures/vscode-package-json.layout.json', 'utf8')), 1033, 367);
if (!layout) throw new Error('Model returned an invalid layout');
const engine = new LocalOcr();
try {
  const words = await recognizeWords(engine, decoded.pixels);
  const result = convert({ fileName: 'vscode.png', pixels: decoded.pixels, words, kind: 'terminal', animated: false, layout });
  await mkdir('eval-results/layout', { recursive: true });
  const report = await validateVisual(result.html, image, result.review.layout ?? layout, 1033, 367, 'eval-results/layout/vscode.png');
  await writeFile('eval-results/layout/vscode.html', report.html);
  await writeFile('eval-results/layout/report.json', JSON.stringify({ ...report, html: undefined, canvasIssues: checkCanvasSafe(report.html) }, null, 2));
  if (process.argv.includes('--live')) console.log(JSON.stringify({ layout: result.review.layout, discrepancies: report.discrepancies }, null, 2));
  // Deliberately damage flex sizing to exercise automatic structural repair.
  const broken = result.html.replace('flex:0 1 150px;min-width:135px;', 'flex:0 1 5px;min-width:0;');
  const recovery = await validateVisual(broken, image, layout, 1033, 367);
  console.log(JSON.stringify({ discrepancies: report.discrepancies, responsive: report.responsive, pixelMeanAbsoluteError: report.pixelMeanAbsoluteError, canvasIssues: checkCanvasSafe(report.html), repairedDamagedColumns: recovery.repaired }, null, 2));
  // Source geometry is diagnostic: a narrow Explorer and wrapped text
  // deliberately differ from the screenshot's fixed pixel rectangles.
  if (report.responsive.some((r) => r.horizontalOverflow || r.clippedText.length) || checkCanvasSafe(report.html).length || (!process.argv.includes('--live') && !recovery.repaired)) process.exitCode = 1;
} finally { await engine.close(); }
