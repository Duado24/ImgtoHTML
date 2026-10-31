import "./style.css";
import { checklistRegions, checklistSummary, focusLines, reviewCounts, reviewReadyText, reviewReading, reviewReasons, type FocusLine } from "./browser/review-status";

import { issuesFor, type ConvertResult, type OutputFile } from "./core/convert";
import type { ModelRegion } from "./core/model";
import { isKind } from "./core/types";
import { SUPPORTED, type JobProgress, type JobResult } from "./shared/api";
import { parseReport } from "./core/report";
import { cancelJob, convertOnServer, decide, editSpan, retryRegion } from "./browser/api";

const MAX_MB = 25;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const shell = $("shell");
const status = $("status");
const form = $<HTMLFormElement>("form");
const go = $<HTMLButtonElement>("go");
const cancel = $<HTMLButtonElement>("cancel");
const reconvert = $<HTMLButtonElement>("reconvert");
const labelInput = $<HTMLInputElement>("label");
const captionInput = $<HTMLInputElement>("caption");
const reportInput = $<HTMLTextAreaElement>("report");

let file: File | null = null;
let lastHTML = "";
/** The server job behind the shown result; review actions act on it. */
let jobId = "";
let action = 0;
let current: ConvertResult | null = null;
let objectUrls: string[] = [];
let editingRegion: string | null = null;
let selectedRegion: string | null = null;
let reviewImage = new Image();
let displayedPercent = 0;

/* ── Refine with ChatGPT: the optional GPT, opened in a new tab.
   Empty until the GPT is published; the button then says "Coming soon". ── */
const PLUGIN_URL = "";
const plugin = $<HTMLAnchorElement>("plugin");
if (PLUGIN_URL) {
  plugin.href = PLUGIN_URL;
  plugin.target = "_blank";
  plugin.rel = "noopener noreferrer";
  plugin.removeAttribute("role");
  plugin.removeAttribute("aria-disabled");
  plugin.removeAttribute("tabindex");
  $("plugin-soon").remove();
  // The app keeps everything local; ChatGPT doesn't, so say so before they paste.
  plugin.title = "Opens ChatGPT in a new tab. What you paste there leaves this computer.";
} else {
  const soon = () => say("Refine with ChatGPT is coming soon. For now, use the checklist below or edit the Transcript tab.");
  plugin.onclick = (e) => { e.preventDefault(); soon(); };
  plugin.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); soon(); } };
}

/* ── Theme: solid black or solid white. Follows the computer's
   light/dark setting until the button is used (then remembered). ── */
const root = document.documentElement;
const systemTheme = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
let savedTheme: string | null = null;
try {
  savedTheme = localStorage.getItem("imgtohtml-theme");
} catch {}
root.dataset.theme = savedTheme ?? systemTheme();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!savedTheme) root.dataset.theme = systemTheme();
});
$("theme").onclick = () => {
  savedTheme = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = savedTheme;
  try {
    localStorage.setItem("imgtohtml-theme", savedTheme);
  } catch {}
};

/* ── Status line ────────────────────────────────── */
function say(msg: string, isErr = false) {
  status.className = "status" + (isErr ? " err" : "");
  status.textContent = msg;
}

function beginProgress() {
  displayedPercent = 0;
  $("conversion-progress").hidden = false;
  updateProgress("Opening the image…", { progress: "Opening the image…", percent: 0, stage: "queued", step: 0, totalSteps: 5 });
}

function updateProgress(message: string, progress?: JobProgress) {
  displayedPercent = Math.max(displayedPercent, Math.min(100, Math.round(progress?.percent ?? displayedPercent)));
  const step = progress?.step ? `Step ${progress.step} of ${progress.totalSteps}: ` : "";
  const text = `${step}${message.replace(/[.…]+$/, "")} — ${displayedPercent}%`;
  $("progress-label").textContent = text;
  $("progress").setAttribute("aria-valuenow", String(displayedPercent));
  $("progress").setAttribute("aria-valuetext", text);
  $("progress-fill").style.width = `${displayedPercent}%`;
  say(text);
}

/* ── AI report: checked as it is pasted, so problems can go back to the AI
   before converting. Boxes are on a 0–1000 grid, so the image size doesn't
   matter here; the server checks it again against the real screenshot. ── */
const REPORT_HELP = $("report-status").textContent ?? "";
reportInput.oninput = () => {
  const status = $("report-status");
  status.classList.remove("report-error");
  const text = reportInput.value.trim();
  if (!text) { status.textContent = REPORT_HELP; return; }
  const parsed = parseReport(text, 1000, 1000);
  if (!parsed.ok) {
    status.classList.add("report-error");
    status.replaceChildren(
      el("span", "", `The report has ${parsed.problems.length === 1 ? "a problem" : `${parsed.problems.length} problems`}. Send ${parsed.problems.length === 1 ? "it" : "them"} back to the AI:`),
      el("ul", ""),
    );
    status.lastElementChild!.append(...parsed.problems.map((p) => el("li", "", p)));
    return;
  }
  const { report, warnings } = parsed.value;
  // The AI looked at the picture: its type wins.
  const kindInput = document.getElementById(`k-${report.kind}`) as HTMLInputElement | null;
  if (kindInput) kindInput.checked = true;
  const regions = report.regions.length;
  status.textContent = `Report ready: ${report.kind} screenshot, ${regions} ${regions === 1 ? "part" : "parts"}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`;
};

/* ── File choice / drag and drop ────────────────── */
const drop = $("drop");
const input = $<HTMLInputElement>("file");

function setFile(f: File | undefined) {
  if (!f || go.disabled) return;
  file = null;
  input.value = "";
  $("fname").textContent = "Drop a screenshot or GIF";
  $("fmeta").textContent = "No file selected";
  const previous = $<HTMLImageElement>("orig");
  if (previous.src.startsWith("blob:")) URL.revokeObjectURL(previous.src);
  previous.removeAttribute("src");
  const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
  if (!(SUPPORTED as readonly string[]).includes(ext)) {
    say("Unsupported image format. Use PNG, JPG, GIF, WEBP, BMP, or TIFF.", true);
    return;
  }
  if (f.size > MAX_MB * 1024 * 1024) {
    say(`That file is larger than ${MAX_MB} MB.`, true);
    return;
  }
  file = f;
  $("fname").textContent = f.name;
  $("fmeta").textContent = (f.size / 1024).toFixed(0) + " KB · click to change";
  const orig = $<HTMLImageElement>("orig");
  if (orig.src.startsWith("blob:")) URL.revokeObjectURL(orig.src);
  // Browsers cannot display TIFF; the server supplies its decoded PNG.
  if (/\.tiff?$/i.test(f.name)) orig.removeAttribute("src");
  else orig.src = URL.createObjectURL(f);
  $("orig-label").textContent = /\.gif$/i.test(f.name) ? "Original · animated; HTML uses the final frame" : "Original";
  say("Ready");
}

input.onchange = () => setFile(input.files?.[0]);
for (const ev of ["dragenter", "dragover"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (e) => setFile((e as DragEvent).dataTransfer?.files[0]));

/* ── Convert ────────────────────────────────────── */
async function run(transcriptText?: string) {
  if (shell.classList.contains("busy")) return;
  if (!file) return say("Choose a screenshot first.", true);
  const kind = new FormData(form).get("kind")?.toString() ?? "terminal";
  if (!isKind(kind)) return say("Choose a supported screenshot type.", true);

  action++;
  shell.classList.add("busy");
  go.disabled = reconvert.disabled = true;
  cancel.hidden = false;
  cancel.disabled = true;
  editingRegion = selectedRegion = null;
  beginProgress();

  try {
    const result = await convertOnServer(file, {
      kind,
      label: labelInput.value,
      caption: captionInput.value,
      transcript: transcriptText,
      editorWindow: $<HTMLInputElement>("window").checked,
      report: reportInput.value,
    }, updateProgress, (id) => { jobId = id; cancel.disabled = false; });
    if (/\.tiff?$/i.test(file.name)) $<HTMLImageElement>("orig").src = result.imageDataUrl;
    show(result, result.preview);
    say(readyText(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A stalled bar would read as still working.
    $("conversion-progress").hidden = true;
    say(`Conversion failed: ${msg}`, true);
  } finally {
    shell.classList.remove("busy");
    cancel.hidden = true;
    go.disabled = reconvert.disabled = false;
  }
}

form.onsubmit = (e) => {
  e.preventDefault();
  void run();
};
reconvert.onclick = () => void run($<HTMLTextAreaElement>("transcript").value);

cancel.onclick = async () => {
  const requestAction = action;
  cancel.disabled = true;
  try {
    const job = await cancelJob(jobId);
    if (requestAction === action && shell.classList.contains("busy") && job.status === "failed") say(job.error, true);
  } catch (error) {
    if (requestAction !== action || !shell.classList.contains("busy")) return;
    say(`Could not cancel: ${error instanceof Error ? error.message : String(error)}`, true);
    cancel.disabled = false;
  }
};

/* ── Show results ───────────────────────────────── */
function downloadButton(out: OutputFile, text: string): HTMLAnchorElement {
  const url = URL.createObjectURL(new Blob([out.content], { type: `${out.mime};charset=utf-8` }));
  objectUrls.push(url);
  const a = document.createElement("a");
  a.className = "btn";
  a.href = url;
  a.download = out.name;
  a.textContent = text;
  a.title = out.name;
  return a;
}

function show(result: ConvertResult, preview: OutputFile) {
  $("empty").hidden = true;
  $("results").hidden = false;
  lastHTML = result.html;
  current = result;
  reviewImage = new Image();
  reviewImage.src = (result as JobResult).imageDataUrl || $<HTMLImageElement>("orig").src;
  renderReview(result);
  const { review } = result;
  $("layout-status").textContent = `Renderer: ${review.layout_status.renderer}.${review.layout_status.reason ? ` Layout not used: ${review.layout_status.reason}.` : ""}`;
  const corrections = review.vision?.corrected ?? [];
  $("vision-corrections").hidden = corrections.length === 0;
  $("correction-list").replaceChildren(...corrections.map(({ from, to }) => el("li", "", `${from} \u2192 ${to}`)));


  $("s-lines").textContent = String(result.lineCount);
  $("s-contrast").textContent = review.contrast_ratio.toFixed(1);
  const background = review.original_colors.background;
  const foreground = review.text_color;
  const others = review.colors_used.length - 1;
  $("sw-bg").style.background = background;
  $("t-bg").textContent = "BG " + background;
  $("sw-fg").style.background = foreground;
  $("t-fg").textContent = "TEXT " + foreground + (others > 0 ? ` +${others}` : "");

  const list = $("issues");
  list.innerHTML = "";
  const names = { error: "Check", warn: "Warning", info: "Note" } as const;
  for (const it of issuesFor(result)) {
    const li = document.createElement("li");
    li.className = it.level;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = names[it.level];
    const body = document.createElement("div");
    body.textContent = it.text;
    if (it.words) {
      const w = document.createElement("div");
      for (const word of it.words) {
        const c = document.createElement("code");
        c.textContent = word;
        w.appendChild(c);
      }
      body.appendChild(w);
    }
    li.append(tag, body);
    list.appendChild(li);
  }

  // Download links replace the out/ folder of the Python version.
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  const files = $("files");
  files.replaceChildren(files.firstElementChild!);
  files.append(
    downloadButton(result.htmlFile, "Canvas HTML"),
    downloadButton(result.transcriptFile, "Transcript"),
    downloadButton(preview, "Comparison page"),
  );
  const technicalFiles = $("technical-files");
  technicalFiles.replaceChildren(technicalFiles.firstElementChild!);
  technicalFiles.append(downloadButton(result.reviewFile, "Review JSON"), downloadButton(result.modelFile, "Model JSON"));

  $("code").textContent = result.html;
  $<HTMLTextAreaElement>("transcript").value = result.transcript;

  const frame = $<HTMLIFrameElement>("render");
  frame.onload = resizePreview;
  frame.srcdoc =
    '<!doctype html><meta name="viewport" content="width=device-width">' +
    '<body style="margin:16px;background:#fff;color:#2d3b45;font-family:Lato,Arial,sans-serif">' +
    result.html +
    "</body>";
}

/* ── Review loop ────────────────────────────────── */
function readyText(r: ConvertResult): string {
  return reviewReadyText(r.model.regions);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = el("button", `btn ${className}`.trim(), text);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

/** Run one review action against the server and show the new result. */
async function act(work: () => Promise<JobResult>, busy: string, cancellable = false) {
  if (!jobId || shell.classList.contains("busy")) return;
  action++;
  cancel.hidden = !cancellable;
  cancel.disabled = true;
  shell.classList.add("busy");
  if (cancellable) beginProgress();
  say(busy);
  try {
    const result = await work();
    show(result, result.preview);
    say(readyText(result));
  } catch (err) {
    say(`That didn't work: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    shell.classList.remove("busy");
    cancel.hidden = true;
  }
}

function highlight(region: string | null) {
  selectedRegion = region;
  for (const box of $("boxes").children) (box as HTMLElement).classList.toggle("active", (box as HTMLElement).dataset.region === region);
  for (const card of $("regions").children) (card as HTMLElement).classList.toggle("active", (card as HTMLElement).dataset.region === region);
}

/** Text in a crop is drawn about this tall (CSS px), so letters can be compared. */
const CROP_LINE_HEIGHT = 22;

/** Crop the decoded original, never a reconstruction or a generated preview:
 *  just the lines with doubtful words, enlarged when the text is small. The
 *  crop keeps that size; a wide one scrolls sideways inside its card. */
function screenshotCrop(lines: readonly FocusLine[], region: ModelRegion): HTMLCanvasElement {
  const canvas = el("canvas", "review-crop");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "This spot in the original screenshot");
  const source = reviewImage;
  const draw = () => {
    const bounds = lines.length ? lines.map((line) => line.box) : [region.box];
    const x = Math.max(0, Math.min(...bounds.map((box) => box.x)) - 8);
    const y = Math.max(0, Math.min(...bounds.map((box) => box.y)) - 8);
    const width = Math.max(1, Math.min(source.naturalWidth - x, Math.max(...bounds.map((box) => box.x + box.width)) - x + 8));
    const height = Math.max(1, Math.min(source.naturalHeight - y, Math.max(...bounds.map((box) => box.y + box.height)) - y + 8));
    const heights = bounds.map((box) => box.height).sort((a, b) => a - b);
    const lineHeight = Math.max(1, heights[Math.floor(heights.length / 2)]!);
    const scale = Math.min(3, Math.max(1, CROP_LINE_HEIGHT / lineHeight), 4000 / width);
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    canvas.getContext("2d")?.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  };
  if (source.complete && source.naturalWidth) draw();
  else source.addEventListener("load", draw, { once: true });
  return canvas;
}

function regionCard(region: ModelRegion, result: ConvertResult, index: number): HTMLLIElement {
  const li = el("li", "region");
  li.dataset.region = region.id;
  li.id = `check-${region.id}`;
  li.tabIndex = 0;
  const checked = region.review === "approved" || region.review === "corrected";
  li.classList.toggle("checked", checked);
  li.append(el("h3", "", `Check ${index + 1}${checked ? " · Checked" : region.review === "skipped" ? " · Skipped for now" : ""}`));
  if (!checked) for (const reason of reviewReasons(region)) li.append(el("p", "review-reason", reason));
  const lines = focusLines(region);
  const comparison = el("div", "review-comparison");
  const picture = el("figure");
  const crop = el("div", "review-crop-scroll");
  crop.append(screenshotCrop(lines, region));
  picture.append(el("figcaption", "", "Original screenshot"), crop);
  const reading = el("figure");
  const text = el("pre", "review-reading");
  lines.forEach((line, i) => {
    if (i) text.append("\n");
    for (const part of line.parts) text.append(part.flagged ? el("mark", "", part.text) : part.text);
  });
  reading.append(el("figcaption", "", checked ? "What the HTML says" : "What the HTML says (words to check are marked)"), text);
  comparison.append(picture, reading);
  li.append(comparison);
  const whole = reviewReading(result, region);
  if (whole.trim() && whole.split("\n").length > lines.length) {
    const more = el("details", "review-whole");
    more.append(el("summary", "", "Show all the text in this part"), el("pre", "review-reading", whole));
    li.append(more);
  }
  li.append(el("p", "review-question", "Is this text the same as the picture?"));
  const editor = el("div", "review-editor");
  editor.hidden = editingRegion !== region.id;
  const edits = new Map<string, { original: string; input: HTMLInputElement }>();
  const flagged = new Set(region.flags.map((flag) => flag.spanId));
  const spans = region.lines.flatMap((line) => line.spans);
  function addEdit(span: (typeof spans)[number], parent: HTMLElement) {
    const row = el("div", "flag");
    const label = el("label", "", `Read as “${span.text}”`);
    const input = el("input");
    input.type = "text";
    input.value = span.text;
    input.id = `edit-${span.id}`;
    label.htmlFor = input.id;
    row.append(label, input);
    edits.set(span.id, { original: span.text, input });
    for (const text of new Set(span.alternatives.map((alternative) => alternative.text).filter((text) => text !== span.text))) {
      row.append(button(`Use “${text}”`, () => { input.value = text; input.focus(); }));
    }
    parent.append(row);
  }
  spans.filter((span) => flagged.has(span.id)).forEach((span) => addEdit(span, editor));
  const otherWords = spans.filter((span) => !flagged.has(span.id));
  if (otherWords.length) {
    const more = el("details");
    more.append(el("summary", "", "Change another word"));
    otherWords.forEach((span) => addEdit(span, more));
    editor.append(more);
  }
  editor.append(button("Save fixes", () => {
    const changes = [...edits].filter(([, value]) => value.input.value !== value.original);
    if (changes.some(([, value]) => !value.input.value.trim() || /\s/.test(value.input.value))) {
      say("Enter one word in each box. Use the Transcript tab to change a whole line.", true);
      return;
    }
    void act(async () => {
      for (const [span, value] of changes) await editSpan(jobId, span, value.input.value);
      const updated = await decide(jobId, region.id, "approved");
      editingRegion = null;
      return updated;
    }, "Saving your fixes…");
  }, "primary"));
  const hint = el("input");
  hint.type = "text";
  hint.placeholder = "Optional hint, e.g. “this says world”";
  hint.setAttribute("aria-label", "Hint for reading this spot again");
  const retry = el("details", "read-again");
  retry.append(el("summary", "", "Read this spot again"), hint,
    button("Focus here", () => void act(() => retryRegion(jobId, region.id, hint.value, updateProgress, () => { cancel.disabled = false; }), "Reading this spot again…", true)));
  editor.append(retry);
  const actions = el("div", "actions");
  actions.append(
    button("Yes, it matches", () => void act(() => decide(jobId, region.id, "approved"), "Saving your check…"), "primary"),
    button("Fix it", () => { editingRegion = editor.hidden ? region.id : null; editor.hidden = !editor.hidden; if (!editor.hidden) editor.querySelector("input")?.focus(); }),
    button("Skip for now", () => void act(() => decide(jobId, region.id, "skipped"), "Skipping for now…")),
  );
  if (checked) actions.firstElementChild?.remove();
  li.append(actions, editor);
  li.addEventListener("click", () => highlight(region.id));
  li.addEventListener("mouseenter", () => highlight(region.id));
  li.addEventListener("focusin", () => highlight(region.id));
  return li;
}

function renderReview(result: ConvertResult) {
  const { width, height, regions } = result.model;
  const flagged = checklistRegions(regions);
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  $("boxes").replaceChildren(
    ...flagged.map((r) => {
      const box = el("button");
      box.type = "button";
      box.dataset.region = r.id;
      box.setAttribute("aria-label", `Check this spot in the screenshot${r.review === "skipped" ? ", skipped for now" : ""}`);
      const serious = r.flags.some((f) => f.reason !== "confusable");
      box.className = r.review === "pending" ? (serious ? "bad" : "") : r.review === "skipped" ? "skipped" : "done";
      Object.assign(box.style, { left: pct(r.box.x / width), top: pct(r.box.y / height), width: pct(r.box.width / width), height: pct(r.box.height / height) });
      box.onclick = () => {
        highlight(r.id);
        $<HTMLDetailsElement>("review").open = true;
        const card = document.getElementById(`check-${r.id}`);
        card?.scrollIntoView({ block: "nearest", behavior: "instant" });
        card?.focus({ preventScroll: true });
      };
      return box;
    }),
  );
  const summary = checklistSummary(result.model);
  $("review-title").textContent = summary.heading;
  $("review-count").textContent = `${summary.checked} of ${summary.total} checked`;
  $("s-low").textContent = String(summary.words);
  $("review-progress").setAttribute("aria-valuenow", String(summary.percent));
  $("review-progress").setAttribute("aria-valuetext", `${summary.checked} of ${summary.total} checked`);
  $("review-progress-fill").style.width = `${summary.percent}%`;
  $("review-skipped").hidden = summary.skipped === 0;
  $("review-skipped").textContent = `${summary.skipped} skipped for now. You can come back to check ${summary.skipped === 1 ? "it" : "them"} before you paste.`;
  $<HTMLButtonElement>("skip-all").hidden = summary.pending === 0;
  $("regions").replaceChildren(...flagged.map((region, index) => regionCard(region, result, index)));
  $("region-details").replaceChildren(...flagged.map((region) => el("li", "", `${region.id} · ${region.role} · ${region.confidence === null ? "unknown confidence" : `${Math.round(region.confidence * 100)}% confidence`} · ${region.review}. ${region.flags.map((flag) => flag.detail).join("; ")}`)));
  highlight(selectedRegion);
}

$("skip-all").onclick = () => void act(() => decide(jobId, "all", "skipped"), "Skipping the rest…");

/* ── Preview width ──────────────────────────────── */
document.querySelectorAll<HTMLInputElement>('input[name="width"]').forEach((r) => {
  r.onchange = () => {
    $("compare").classList.toggle("phone", r.value === "phone" && r.checked);
    requestAnimationFrame(resizePreview);
  };
});

function resizePreview() {
  const frame = $<HTMLIFrameElement>("render");
  // Reset before measuring so a previous tall view can shrink after reflow.
  frame.style.height = "240px";
  const height = frame.contentDocument?.documentElement.scrollHeight ?? 0;
  frame.style.height = Math.max(240, height + 4) + "px";
}
let previewWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry && entry.contentRect.width !== previewWidth) {
    previewWidth = entry.contentRect.width;
    resizePreview();
  }
}).observe($("compare"));

/* ── Copy ───────────────────────────────────────── */
$("copy").onclick = async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText(lastHTML);
    copied = true;
  } catch {
    const t = document.createElement("textarea");
    t.value = lastHTML;
    document.body.appendChild(t);
    try {
      t.select();
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      t.remove();
    }
  }
  if (!copied) {
    $("copy-text").textContent = "Copy failed";
    say("Could not copy HTML. Select the HTML and copy it manually.", true);
    return;
  }
  const counts = current ? reviewCounts(current.model.regions) : { pending: 0, skipped: 0 };
  const left = counts.pending + counts.skipped;
  $("copy-text").textContent = left ? `Copied - ${left} unverified` : "Copied";
  setTimeout(() => ($("copy-text").textContent = "Copy HTML"), left ? 3200 : 1600);
};

/* ── Tabs (click + arrow keys) ──────────────────── */
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function pick(tab: HTMLButtonElement) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")!).hidden = !on;
  }
  tab.focus();
}
tabs.forEach((t, i) => {
  t.onclick = () => pick(t);
  t.onkeydown = (e) => {
    if (e.key === "ArrowRight") pick(tabs[(i + 1) % tabs.length]!);
    if (e.key === "ArrowLeft") pick(tabs[(i - 1 + tabs.length) % tabs.length]!);
  };
});
