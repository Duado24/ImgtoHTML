import "./style.css";
import { checklistSummary, markLine, reasons, readyText, type Decision } from "./browser/review-status";
import { convert, type Check, type ConvertResult, type OutputFile } from "./core/convert";
import { AI_INSTRUCTIONS } from "./core/prompt";
import { parseReport, type ScreenshotReport } from "./core/report";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
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

const reportInput = $<HTMLTextAreaElement>("report");
const labelInput = $<HTMLInputElement>("label");
const captionInput = $<HTMLInputElement>("caption");
const windowInput = $<HTMLInputElement>("window");
const reportStatus = $("report-status");

/** The report being worked on: as pasted, plus the designer's fixes. */
let report: ScreenshotReport | null = null;
let warnings: string[] = [];
let decisions = new Map<string, Decision>();
let result: ConvertResult | null = null;
let editing: string | null = null;
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

/* ── Get a report with ChatGPT: the optional GPT, opened in a new tab.
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
  plugin.title = "Opens ChatGPT in a new tab. Screenshots you send there go to ChatGPT.";
} else {
  const soon = () => { reportStatus.textContent = "The ChatGPT plugin is coming soon. For now, copy the AI instructions into any AI chat."; };
  plugin.onclick = (e) => { e.preventDefault(); soon(); };
  plugin.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); soon(); } };
}

/* ── 01 Get a report: the instructions any AI chat needs. ── */
$("instructions").textContent = AI_INSTRUCTIONS;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = el("textarea");
    t.value = text;
    document.body.appendChild(t);
    try {
      t.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      t.remove();
    }
  }
}

$("copy-instructions").onclick = async () => {
  const label = $("copy-instructions-text");
  label.textContent = (await copyText(AI_INSTRUCTIONS)) ? "Copied" : "Copy failed: use Show the instructions";
  setTimeout(() => (label.textContent = "Copy AI instructions"), 2400);
};

/* ── 02 Paste the report: checked as it's typed or pasted. ── */
const HELP = reportStatus.textContent ?? "";

function readReport() {
  reportStatus.classList.remove("report-error");
  const text = reportInput.value.trim();
  if (!text) {
    report = null;
    reportStatus.textContent = HELP;
    show();
    return;
  }
  const parsed = parseReport(text);
  if (!parsed.ok) {
    report = null;
    reportStatus.classList.add("report-error");
    const n = parsed.problems.length;
    reportStatus.replaceChildren(el("span", "", `The report has ${n === 1 ? "a problem" : `${n} problems`}. Send ${n === 1 ? "it" : "them"} back to the AI:`), el("ul"));
    reportStatus.lastElementChild!.append(...parsed.problems.map((p) => el("li", "", p)));
    show();
    return;
  }
  report = parsed.report;
  warnings = parsed.warnings;
  decisions = new Map();
  editing = null;
  show();
}

let timer: ReturnType<typeof setTimeout> | undefined;
reportInput.oninput = () => {
  clearTimeout(timer);
  timer = setTimeout(readReport, 200);
};
for (const input of [labelInput, captionInput]) input.oninput = () => show();
windowInput.onchange = () => show();

/** Put the designer's fixes back in the pasted report, without starting over. */
function saveFixes() {
  if (report) reportInput.value = JSON.stringify(report, null, 2);
}

/* ── Results ─────────────────────────────────────── */
function downloadButton(out: OutputFile, text: string): HTMLAnchorElement {
  const url = URL.createObjectURL(new Blob([out.content], { type: `${out.mime};charset=utf-8` }));
  objectUrls.push(url);
  const a = el("a", "btn", text);
  a.href = url;
  a.download = out.name;
  a.title = out.name;
  return a;
}

function show() {
  if (!report) {
    result = null;
    $("empty").hidden = false;
    $("results").hidden = true;
    return;
  }
  result = convert(report, { label: labelInput.value, caption: captionInput.value, editorWindow: windowInput.checked });
  labelInput.placeholder = result.label;
  $("empty").hidden = true;
  $("results").hidden = false;
  const { kind, renderer, checks } = result;
  const regions = report.regions.length;
  reportStatus.textContent = `Report ready: ${kind} screenshot, ${regions} ${regions === 1 ? "part" : "parts"}. ${readyText(checks, decisions)}`;

  renderReview(checks);

  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  const files = $("files");
  files.replaceChildren(files.firstElementChild!);
  const fixedReport = { name: result.htmlFile.name.replace(/^Media_/, "").replace(/\.html$/, "_report.json"), mime: "application/json", content: JSON.stringify(report, null, 2) };
  files.append(downloadButton(result.htmlFile, "Canvas HTML"), downloadButton(result.transcriptFile, "Transcript"), downloadButton(fixedReport, "Report with your fixes"));

  const notes: { level: "error" | "warn" | "info"; text: string }[] = [
    { level: "info", text: `Drawn as: ${({ terminal: "a terminal", code: "a code block", "editor-window": "a code editor window", panels: "app panels", diagram: "a diagram description" } as const)[renderer]}.` },
    ...result.canvasIssues.map((i) => ({ level: i.level === "error" ? "error" as const : "warn" as const, text: `Canvas: ${i.message}` })),
    ...result.contrastChanges.map((c) => ({ level: "info" as const, text: `Text color ${c.from} changed to ${c.to} so it reads on ${c.background} (4.5:1).` })),
    ...(result.maskedNames ? [{ level: "info" as const, text: `Masked ${result.maskedNames} user ${result.maskedNames === 1 ? "name" : "names"} in home-folder paths and emails as “username”. Check for other names yourself.` }] : []),
    ...(result.notes ? [{ level: "info" as const, text: `The AI's notes: ${result.notes}` }] : []),
    ...warnings.map((w) => ({ level: "warn" as const, text: `Report: ${w}` })),
    ...(kind === "diagram" ? [{ level: "info" as const, text: "Diagrams become a \"Diagram Description\" dropdown. Upload the screenshot to Canvas as an image and paste this under it." }] : []),
  ];
  const names = { error: "Check", warn: "Warning", info: "Note" } as const;
  $("issues").replaceChildren(...notes.map((n) => {
    const li = el("li", n.level);
    li.append(el("span", "tag", names[n.level]), el("div", "", n.text));
    return li;
  }));

  $("code").textContent = result.html;
  const frame = $<HTMLIFrameElement>("render");
  frame.onload = resizePreview;
  frame.srcdoc =
    '<!doctype html><meta name="viewport" content="width=device-width">' +
    '<body style="margin:16px;background:#fff;color:#2d3b45;font-family:Lato,Arial,sans-serif">' +
    result.html +
    "</body>";
}

/* ── Checklist ───────────────────────────────────── */
function renderReview(checks: readonly Check[]) {
  const summary = checklistSummary(checks, decisions);
  $("review-title").textContent = summary.heading;
  $("review-count").textContent = `${summary.checked} of ${summary.total} checked`;
  $("s-low").textContent = String(summary.words);
  $("review-progress").setAttribute("aria-valuenow", String(summary.percent));
  $("review-progress").setAttribute("aria-valuetext", `${summary.checked} of ${summary.total} checked`);
  $("review-progress-fill").style.width = `${summary.percent}%`;
  $("review-skipped").hidden = summary.skipped === 0;
  $("review-skipped").textContent = `${summary.skipped} skipped for now. You can come back to check ${summary.skipped === 1 ? "it" : "them"} before you paste.`;
  $<HTMLButtonElement>("skip-all").hidden = summary.pending === 0;
  $("regions").replaceChildren(...checks.map((check, i) => checkCard(check, i)));
}

function decide(region: string, decision: Decision) {
  decisions.set(region, decision);
  editing = null;
  show();
}

function checkCard(check: Check, index: number): HTMLLIElement {
  const decision = decisions.get(check.region);
  const checked = decision === "approved" || decision === "corrected";
  const li = el("li", `region${checked ? " checked" : ""}`);
  li.dataset.region = check.region;
  li.append(el("h3", "", `Check ${index + 1} · ${check.title}${checked ? " · Checked" : decision === "skipped" ? " · Skipped for now" : ""}`));
  if (!checked) for (const reason of reasons(check)) li.append(el("p", "review-reason", reason));

  const text = el("pre", "review-reading");
  check.lines.forEach((line, i) => {
    if (i) text.append("\n");
    for (const part of markLine(line, check.unsure, check.cutOff.includes(i + 1))) text.append(part.marked ? el("mark", "", part.text) : part.text);
  });
  li.append(el("p", "review-caption", "What the HTML says (words to check are marked):"), text, el("p", "review-question", "Is this the same as your screenshot?"));

  const region = report!.regions.find((r) => r.id === check.region)!;
  const editor = el("div", "review-editor");
  editor.hidden = editing !== check.region;
  const area = el("textarea");
  area.rows = Math.min(16, Math.max(3, region.lines.length));
  area.spellcheck = false;
  area.value = region.lines.join("\n");
  area.setAttribute("aria-label", `Text of ${check.title}, one line per line`);
  editor.append(
    el("p", "help", "Fix the text so it matches your screenshot exactly. Leave cut-off lines as far as the screenshot shows them."),
    area,
    button("Save fix", () => {
      region.lines = area.value.replace(/\r/g, "").split("\n");
      // Words fixed or confirmed by hand are no longer in doubt.
      delete region.unsure_words;
      region.cut_off_lines = region.cut_off_lines?.filter((n) => n <= region.lines.length);
      saveFixes();
      decide(check.region, "corrected");
    }, "primary"),
  );

  const actions = el("div", "actions");
  if (!checked) actions.append(button("Yes, it matches", () => decide(check.region, "approved"), "primary"));
  actions.append(
    button("Fix it", () => { editing = editor.hidden ? check.region : null; editor.hidden = !editor.hidden; if (!editor.hidden) area.focus(); }),
    ...(checked ? [] : [button("Skip for now", () => decide(check.region, "skipped"))]),
  );
  li.append(actions, editor);
  return li;
}

$("skip-all").onclick = () => {
  for (const check of result?.checks ?? []) if (!decisions.has(check.region)) decisions.set(check.region, "skipped");
  show();
};

/* ── Preview width ──────────────────────────────── */
document.querySelectorAll<HTMLInputElement>('input[name="width"]').forEach((r) => {
  r.onchange = () => {
    $("frame").classList.toggle("phone", r.value === "phone" && r.checked);
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
}).observe($("frame"));

/* ── Copy ───────────────────────────────────────── */
$("copy").onclick = async () => {
  if (!result) return;
  const label = $("copy-text");
  if (!(await copyText(result.html))) {
    label.textContent = "Copy failed";
    reportStatus.textContent = "Couldn't copy the HTML. Select it and copy it by hand.";
    return;
  }
  const { remaining } = checklistSummary(result.checks, decisions);
  label.textContent = remaining ? `Copied - ${remaining} unverified` : "Copied";
  setTimeout(() => (label.textContent = "Copy HTML"), remaining ? 3200 : 1600);
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
