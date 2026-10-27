import "./style.css";

import { issuesFor, type ConvertResult, type OutputFile } from "./core/convert";
import type { ModelRegion } from "./core/model";
import { isKind } from "./core/types";
import { SUPPORTED, type JobResult } from "./shared/api";
import { convertOnServer, decide, editSpan, retryRegion } from "./browser/api";

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
const reconvert = $<HTMLButtonElement>("reconvert");
const labelInput = $<HTMLInputElement>("label");
const captionInput = $<HTMLInputElement>("caption");

let file: File | null = null;
let lastHTML = "";
/** The server job behind the shown result; review actions act on it. */
let jobId = "";
let current: ConvertResult | null = null;
let objectUrls: string[] = [];

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
  if (!isErr) {
    const c = document.createElement("span");
    c.className = "cursor";
    c.setAttribute("aria-hidden", "true");
    status.appendChild(c);
  }
}

/* ── File choice / drag and drop ────────────────── */
const drop = $("drop");
const input = $<HTMLInputElement>("file");

function setFile(f: File | undefined) {
  if (!f || go.disabled) return;
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
  if (!file) return say("Choose a screenshot first.", true);
  const kind = new FormData(form).get("kind")?.toString() ?? "terminal";
  if (!isKind(kind)) return say("Choose a supported screenshot type.", true);

  shell.classList.add("busy");
  go.disabled = reconvert.disabled = true;

  try {
    const result = await convertOnServer(file, {
      kind,
      label: labelInput.value,
      caption: captionInput.value,
      transcript: transcriptText,
    }, (message) => say(message), (id) => (jobId = id));
    if (/\.tiff?$/i.test(file.name)) $<HTMLImageElement>("orig").src = result.imageDataUrl;
    show(result, result.preview);
    say(readyText(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    say(`Conversion failed: ${msg}`, true);
  } finally {
    shell.classList.remove("busy");
    go.disabled = reconvert.disabled = false;
  }
}

form.onsubmit = (e) => {
  e.preventDefault();
  void run();
};
reconvert.onclick = () => void run($<HTMLTextAreaElement>("transcript").value);

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
  renderReview(result);
  const { review } = result;

  $("s-lines").textContent = String(result.lineCount);
  $("s-low").textContent = String(result.lowConfidenceCount);
  $("s-low").style.color = result.lowConfidenceCount ? "var(--coral)" : "";
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
    downloadButton(result.reviewFile, "Review JSON"),
    downloadButton(result.modelFile, "Model JSON"),
    downloadButton(preview, "Comparison page"),
  );

  $("code").textContent = result.html;
  $<HTMLTextAreaElement>("transcript").value = result.transcript;

  const frame = $<HTMLIFrameElement>("render");
  frame.onload = () => {
    const h = frame.contentDocument?.documentElement.scrollHeight ?? 0;
    frame.style.height = Math.max(240, h + 4) + "px";
  };
  frame.srcdoc =
    '<!doctype html><meta name="viewport" content="width=device-width">' +
    '<body style="margin:16px;background:#fff;color:#2d3b45;font-family:Lato,Arial,sans-serif">' +
    result.html +
    "</body>";
}

/* ── Review loop ────────────────────────────────── */
const toReview = (r: ConvertResult) => r.model.regions.filter((x) => x.review === "pending" && x.flags.length);

function readyText(r: ConvertResult): string {
  const n = toReview(r).length;
  return n ? `Draft ready. ${n} ${n === 1 ? "region needs" : "regions need"} a look before Canvas.` : "Draft ready. Nothing left to review.";
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
async function act(work: () => Promise<JobResult>, busy: string) {
  if (!jobId) return;
  shell.classList.add("busy");
  say(busy);
  try {
    const result = await work();
    show(result, result.preview);
    say(readyText(result));
  } catch (err) {
    say(`That didn't work: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    shell.classList.remove("busy");
  }
}

function highlight(region: string | null) {
  for (const box of $("boxes").children) (box as HTMLElement).classList.toggle("active", (box as HTMLElement).dataset.region === region);
  for (const card of $("regions").children) (card as HTMLElement).classList.toggle("active", (card as HTMLElement).dataset.region === region);
}

function regionCard(region: ModelRegion): HTMLLIElement {
  const li = el("li", "region");
  li.dataset.region = region.id;
  const sure = region.confidence === null ? "" : ` · ${Math.round(region.confidence * 100)}% sure`;
  li.append(el("h3", "", `${region.id} · ${region.role}${sure}`));

  // One row per flagged word: why it was flagged, other readings to pick, or type it.
  const spans = new Map(region.lines.flatMap((l) => l.spans).map((s) => [s.id, s]));
  const reasons = new Map<string, string[]>();
  for (const flag of region.flags) reasons.set(flag.spanId, [...(reasons.get(flag.spanId) ?? []), flag.detail]);
  for (const [spanId, details] of reasons) {
    const span = spans.get(spanId);
    if (!span) continue;
    const row = el("div", "flag");
    row.append(el("code", "", span.text), el("span", "", details.join(" · ")));
    for (const text of new Set(span.alternatives.map((a) => a.text).filter((t) => t !== span.text))) {
      const use = button("Use ", () => void act(() => editSpan(jobId, span.id, text), "Saving…"));
      use.append(el("code", "", text)); // shown as is: the button style uppercases its own label
      row.append(use);
    }
    const input = el("input");
    input.value = span.text;
    input.setAttribute("aria-label", `Correct the word “${span.text}”`);
    row.append(input, button("Save", () => void act(() => editSpan(jobId, span.id, input.value), "Saving…")));
    li.append(row);
  }

  const hint = el("input");
  hint.placeholder = "Optional hint, e.g. “this is a table”";
  hint.setAttribute("aria-label", `Hint for reading ${region.id} again`);
  const actions = el("div", "actions");
  actions.append(
    button("Looks right", () => void act(() => decide(jobId, region.id, "approved"), "Saving…"), "primary"),
    button("Doesn't look right — focus here", () => void act(() => retryRegion(jobId, region.id, hint.value, (m) => say(m)), `Reading ${region.id} again…`)),
    hint,
    button("Skip", () => void act(() => decide(jobId, region.id, "skipped"), "Saving…")),
  );
  li.append(actions);
  li.addEventListener("mouseenter", () => highlight(region.id));
  li.addEventListener("focusin", () => highlight(region.id));
  li.addEventListener("mouseleave", () => highlight(null));
  return li;
}

function renderReview(result: ConvertResult) {
  const { width, height, regions } = result.model;
  const flagged = regions.filter((r) => r.flags.length);
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  $("boxes").replaceChildren(
    ...flagged.map((r) => {
      const box = el("div");
      box.dataset.region = r.id;
      const serious = r.flags.some((f) => f.reason !== "confusable");
      box.className = r.review === "pending" ? (serious ? "bad" : "") : r.review === "skipped" ? "skipped" : "done";
      Object.assign(box.style, { left: pct(r.box.x / width), top: pct(r.box.y / height), width: pct(r.box.width / width), height: pct(r.box.height / height) });
      return box;
    }),
  );
  const pending = toReview(result);
  $("review").hidden = flagged.length === 0;
  $("review-count").textContent = pending.length ? `· ${pending.length} to check` : "· done";
  $<HTMLButtonElement>("skip-all").disabled = pending.length === 0;
  $("regions").replaceChildren(...pending.map(regionCard));
}

$("skip-all").onclick = () => void act(() => decide(jobId, "all", "skipped"), "Skipping the rest…");

/* ── Preview width ──────────────────────────────── */
document.querySelectorAll<HTMLInputElement>('input[name="width"]').forEach((r) => {
  r.onchange = () => $("compare").classList.toggle("phone", r.value === "phone" && r.checked);
});

/* ── Copy ───────────────────────────────────────── */
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(lastHTML);
  } catch {
    const t = document.createElement("textarea");
    t.value = lastHTML;
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  // A warning, not a block: unreviewed regions may still hold OCR mistakes.
  const left = current ? toReview(current).length : 0;
  $("copy-text").textContent = left ? `Copied — ${left} not reviewed` : "Copied ✓";
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
