import "./style.css";

import { issuesFor, type ConvertResult, type OutputFile } from "./core/convert";
import { isKind } from "./core/types";
import { SUPPORTED } from "./shared/api";
import { convertOnServer } from "./browser/api";

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
    }, (message) => say(message));
    if (/\.tiff?$/i.test(file.name)) $<HTMLImageElement>("orig").src = result.imageDataUrl;
    show(result, result.preview);
    say("Draft ready. Review it before pasting into Canvas.");
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
  $("copy-text").textContent = "Copied ✓";
  setTimeout(() => ($("copy-text").textContent = "Copy HTML"), 1600);
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
