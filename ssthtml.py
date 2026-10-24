#!/usr/bin/env python3
"""
screenshot_to_html.py
Turn code / terminal screenshots into Canvas-ready, VS Code-style HTML.

Setup (once):
    pip install anthropic pygments
    export ANTHROPIC_API_KEY=sk-ant-...        (Windows: set ANTHROPIC_API_KEY=...)

Usage:
    python screenshot_to_html.py image.png
    python screenshot_to_html.py screenshots_folder/ --out html_out/
    python screenshot_to_html.py screenshots_folder/ --limit 25   (do a chunk)

Each image produces <name>.html. A review.csv lists every file with the
model's uncertainty notes and a Python syntax check, so you know which
pages need a human look before they go into Canvas.
"""
import argparse, base64, csv, html, json, mimetypes, re, sys, ast
from pathlib import Path

import anthropic
from pygments import lex
from pygments.lexers import get_lexer_by_name, guess_lexer_for_filename
from pygments.token import Token
from pygments.util import ClassNotFound

MODEL = "claude-sonnet-5-5"
USERNAME_PLACEHOLDER = "username"
MONO = "Consolas, 'Courier New', monospace"
SANS = "Arial, Helvetica, sans-serif"

# ---------------------------------------------------------------- 1. read image
PROMPT = """You are transcribing a screenshot from a programming course so it can be
replaced by accessible HTML. Transcribe EXACTLY what is visible: every character,
quote, colon, bracket and space of indentation. Never fix, improve, or complete
the code. If a character is unreadable, give your best reading and mention it in
"uncertain".

Return ONLY JSON with this shape:
{
  "kind": "editor" | "terminal" | "editor_with_terminal" | "output",
  "project_folder": "folder shown in Explorer, or null",
  "filename": "open file name, or null",
  "language": "python | javascript | html | ... | text",
  "start_line": 1,
  "code": "editor contents exactly, with \\n newlines, or null",
  "terminal": [ {"type": "prompt", "path": "PS C:\\\\...>", "command": "python x.py"},
                {"type": "output", "text": "..."},
                {"type": "error",  "text": "..."} ],
  "alt_summary": "one sentence describing what the screenshot shows",
  "uncertain": "anything you could not read confidently, or empty string"
}"""

def read_screenshot(client, path: Path) -> dict:
    media = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.standard_b64encode(path.read_bytes()).decode()
    msg = client.messages.create(
        model=MODEL, max_tokens=4000,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}},
            {"type": "text", "text": PROMPT}]}])
    text = msg.content[0].text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    return json.loads(text)

# ------------------------------------------------------------- 2. clean data
def scrub_usernames(s: str) -> str:
    """Replace real Windows/mac/Linux usernames with a placeholder."""
    if not s:
        return s
    s = re.sub(r"(C:\\\\?Users\\\\?)([^\\\\/\s]+)",
               lambda m: m.group(1) + USERNAME_PLACEHOLDER, s, flags=re.I)
    s = re.sub(r"(/(?:Users|home)/)([^/\s]+)", r"\1" + USERNAME_PLACEHOLDER, s)
    return s

def scrub(d: dict) -> dict:
    for k in ("code", "project_folder"):
        d[k] = scrub_usernames(d.get(k) or "") or None
    for line in d.get("terminal") or []:
        for k in ("path", "command", "text"):
            if k in line:
                line[k] = scrub_usernames(line[k])
    return d

# ------------------------------------------------------- 3. syntax colours
COLORS = [  # VS Code Dark Modern
    (Token.Comment, "#6a9955"), (Token.Literal.String, "#ce9178"),
    (Token.Literal.Number, "#b5cea8"), (Token.Keyword.Constant, "#569cd6"),
    (Token.Keyword, "#c586c0"), (Token.Name.Builtin, "#dcdcaa"),
    (Token.Name.Function, "#dcdcaa"), (Token.Name.Class, "#4ec9b0"),
    (Token.Name.Decorator, "#dcdcaa"), (Token.Operator, "#d4d4d4"),
    (Token.Name, "#9cdcfe"),
]
def color_for(tok):
    for t, c in COLORS:
        if tok in t:
            return c
    return "#cccccc"

def highlight_lines(code: str, language: str, filename: str | None):
    try:
        lexer = guess_lexer_for_filename(filename, code) if filename else get_lexer_by_name(language or "text")
    except ClassNotFound:
        lexer = get_lexer_by_name("text")
    lines, cur = [], []
    for tok, val in lex(code, lexer):
        parts = val.split("\n")
        for i, part in enumerate(parts):
            if i:
                lines.append("".join(cur)); cur = []
            if part:
                cur.append(f'<span style="color: {color_for(tok)};">{html.escape(part)}</span>')
    if cur:
        lines.append("".join(cur))
    while lines and lines[-1] == "":
        lines.pop()
    return lines or [""]

# ---------------------------------------------------------- 4. build HTML
HIDE = 'aria-hidden="true"'
ICON = f'<span {HIDE} style="color: #4fa4d8;">◆</span>'

def explorer(folder, filename):
    if not (folder or filename):
        return ""
    return f'''<div style="flex: 0 1 150px; min-width: 135px; background-color: #181818; border-right: 1px solid #2b2b2b;">
<div style="padding: 8px 12px 6px; font-family: {SANS}; font-size: 12px; color: #cccccc;">Explorer</div>
<div style="padding: 7px 8px; font-family: {SANS}; font-size: 12px; color: #cccccc;">
{f'<div style="margin-bottom: 6px;"><span {HIDE} style="color: #858585;">⌄</span> {html.escape(folder)}</div>' if folder else ''}
{f'<div style="background-color: #2a2d2e; border-radius: 4px; padding: 5px 8px;">{ICON} <span style="margin-left: 5px;">{html.escape(filename)}</span></div>' if filename else ''}
</div></div>'''

def editor(d):
    code = d.get("code")
    if not code:
        return ""
    fn = d.get("filename")
    start = int(d.get("start_line") or 1)
    rows = "\n".join(
        f'<div style="display: flex;"><div {HIDE} style="flex: 0 0 38px; text-align: right; padding-right: 12px; color: #858585;">{start+i}</div>'
        f'<div style="flex: 1; min-width: 0; white-space: pre;">{ln or " "}</div></div>'
        for i, ln in enumerate(highlight_lines(code, d.get("language"), fn)))
    tab = (f'<div style="display: flex; flex-wrap: wrap; background-color: #181818; border-bottom: 1px solid #2b2b2b; font-family: {SANS}; font-size: 12px;">'
           f'<div style="background-color: #1f1f1f; padding: 9px 12px 8px;">{ICON} <span style="margin-left: 5px; color: #ffffff;">{html.escape(fn)}</span></div></div>') if fn else ""
    return f'''{tab}
<pre style="margin: 0; padding: 4px 0 20px; background-color: #181818; font-family: {MONO}; font-size: 13px; overflow-x: auto;"><code>{rows}</code></pre>'''

def terminal(d):
    lines = d.get("terminal") or []
    if not lines:
        return ""
    out = []
    for ln in lines:
        t = ln.get("type")
        if t == "prompt":
            out.append(f'<div><span style="color: #cccccc;">{html.escape(ln.get("path",""))} </span>'
                       f'<span style="color: #dcdcaa;">{html.escape(ln.get("command",""))}</span></div>')
        else:
            color = "#f14c4c" if t == "error" else "#cccccc"
            out.append(f'<div style="color: {color}; white-space: pre-wrap;">{html.escape(ln.get("text",""))}</div>')
    border = "border-top: 1px solid #2b2b2b;" if d.get("code") else ""
    return f'''<div style="{border}">
<div {HIDE} style="display: flex; flex-wrap: wrap; gap: 2px; background-color: #181818; padding: 0 8px; border-bottom: 1px solid #2b2b2b; font-family: {SANS}; font-size: 11px;">
<span style="padding: 9px 8px; color: #858585;">Problems</span><span style="padding: 9px 8px; color: #858585;">Output</span>
<span style="padding: 7px 10px; margin: 2px 0; color: #ffffff; background-color: #333333; border-radius: 3px;">Terminal</span></div>
<div role="region" aria-label="Terminal" style="background-color: #181818; padding: 14px 16px 16px; font-family: {MONO}; font-size: 12px; line-height: 1.5;">
{"".join(out)}</div></div>'''

def build_html(d):
    label = html.escape(d.get("alt_summary") or "Code example")
    return f'''<div role="figure" aria-label="{label}" style="display: flex; flex-wrap: wrap; background-color: #181818; color: #cccccc; border-radius: 0.75rem; overflow: hidden; font-family: {MONO}; border: 1px solid #2b2b2b;">
{explorer(d.get("project_folder"), d.get("filename"))}
<div style="flex: 1 1 520px; min-width: 280px;">
{editor(d)}
{terminal(d)}
</div></div>'''

# ------------------------------------------------------------ 5. checks
def syntax_check(d):
    if (d.get("language") or "").lower() != "python" or not d.get("code"):
        return "n/a"
    try:
        ast.parse(d["code"]); return "ok"
    except SyntaxError as e:
        return f"SyntaxError line {e.lineno}: {e.msg} (may be intentional)"

# ------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input"); ap.add_argument("--out", default="html_out")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    src, out = Path(a.input), Path(a.out); out.mkdir(parents=True, exist_ok=True)
    exts = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
    imgs = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.suffix.lower() in exts)
    done = {r["image"] for r in csv.DictReader(open(out/"review.csv"))} if (out/"review.csv").exists() else set()
    imgs = [p for p in imgs if str(p) not in done]          # resume where you left off
    if a.limit: imgs = imgs[:a.limit]

    client = anthropic.Anthropic()
    new = not (out/"review.csv").exists()
    with open(out/"review.csv", "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new: w.writerow(["image", "html", "kind", "syntax_check", "uncertain", "status"])
        for i, p in enumerate(imgs, 1):
            print(f"[{i}/{len(imgs)}] {p.name}", end=" ... ", flush=True)
            try:
                d = scrub(read_screenshot(client, p))
                target = out / (p.stem + ".html")
                target.write_text(build_html(d), encoding="utf-8")
                sc, unc = syntax_check(d), d.get("uncertain", "")
                status = "needs review" if unc or sc.startswith("Syntax") else "spot-check"
                w.writerow([str(p), str(target), d.get("kind"), sc, unc, status]); print(status)
            except Exception as e:
                w.writerow([str(p), "", "", "", f"FAILED: {e}", "failed"]); print("FAILED", e)
            f.flush()

if __name__ == "__main__":
    main()