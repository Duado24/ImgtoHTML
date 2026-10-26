import { describe, expect, it } from "vitest";
import { plainLines } from "../src/core/paint";
import { render, renderPanels } from "../src/core/render";
import type { Region } from "../src/core/regions";
import type { Kind } from "../src/core/types";

const SAMPLE = [
  "Welcome to VitalLink! Let's get you signed up.",
  "",
  '    indented <tag> & "quotes"',
  "",
  "Thank you for signing up!",
];

const make = (kind: Kind = "terminal", caption?: string) =>
  render(plainLines(SAMPLE), kind, "A label", [0x18, 0x18, 0x18], [0xcc, 0xcc, 0xcc], caption);

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/** Text and style of each line <div> (the ones indented four spaces). */
function linesOf(fragment: string) {
  const found = [...fragment.matchAll(/^ {4}<div style="([^"]*)">(.*)<\/div>$/gm)];
  return {
    lines: found.map((m) => (m[2] === "<br>" ? "" : unescape(m[2]!))),
    styles: found.map((m) => m[1]!),
  };
}

describe("render", () => {
  it("one div per line, text intact", () => {
    expect(linesOf(make()).lines).toEqual(SAMPLE);
  });

  it("no <pre> block for Canvas to split", () => {
    expect(make()).not.toContain("<pre");
  });

  it("blank lines kept as empty lines", () => {
    expect(make().split("<br></div>").length - 1).toBe(2);
  });

  it("HTML characters escaped", () => {
    expect(make()).toContain("&lt;tag&gt; &amp;");
  });

  it("terminal wraps with a hanging indent", () => {
    const { styles } = linesOf(make("terminal"));
    expect(styles.every((s) => s.includes("pre-wrap") && s.includes("text-indent:-2ch"))).toBe(true);
    expect(make("terminal")).not.toContain("overflow-x:auto");
  });

  it("code never wraps and scrolls in its box", () => {
    const { styles } = linesOf(make("code"));
    expect(styles.every((s) => s.includes("white-space:pre;"))).toBe(true);
    expect(make("code")).toContain("overflow-x:auto");
  });

  it("caption outside the text box", () => {
    const fragment = make("terminal", "Animated in the original.");
    expect(fragment).toContain("Animated in the original.</p>");
    expect(fragment.indexOf("Thank you")).toBeLessThan(fragment.indexOf("<p "));
  });

  it("label is escaped inside the attribute", () => {
    const fragment = render(plainLines(["x"]), "terminal", 'Say "hi" & <go>', [0, 0, 0], [255, 255, 255]);
    expect(fragment).toContain('aria-label="Say &quot;hi&quot; &amp; &lt;go&gt;"');
  });

  it("colored runs become spans; the box's own text color doesn't", () => {
    const fragment = render(
      [{ runs: [{ text: "print", color: [0xdc, 0xdc, 0xaa] }, { text: "(", color: [0xcc, 0xcc, 0xcc] }, { text: '"hi"', color: [0xce, 0x91, 0x78] }, { text: ")" }] }],
      "code", "A label", [0x18, 0x18, 0x18], [0xcc, 0xcc, 0xcc],
    );
    expect(fragment).toContain(
      '<span style="color:#dcdcaa;">print</span>(<span style="color:#ce9178;">&quot;hi&quot;</span>)',
    );
  });
});

describe("panels", () => {
  const leaf = (x: number, width: number, bg: number): Region => ({
    kind: "leaf", box: { x, y: 0, width, height: 100 }, background: [bg, bg, bg], words: [],
  });
  const tree: Region = {
    kind: "split", direction: "row", box: { x: 0, y: 0, width: 600, height: 100 },
    background: [0x18, 0x18, 0x18], separator: [0x2b, 0x2b, 0x2b],
    children: [leaf(0, 150, 0x18), leaf(151, 449, 0x1f)],
  };
  const html = renderPanels(
    tree,
    (l) => ({
      lines: l.box.x === 0 ? plainLines(["Explorer"]) : plainLines(["print"]),
      fontSize: 12,
      padding: { top: 4, right: 8, bottom: 4, left: 8 },
    }),
    "Editor",
  );

  it("side-by-side panels keep their colors and wrap on narrow screens", () => {
    expect(html).toContain("display:flex;flex-wrap:wrap;");
    expect(html).toContain("flex:0 1 150px;");
    expect(html).toContain("flex:1 1 449px;");
    expect(html).toContain("background-color:#1f1f1f;");
    expect(html).toContain("border-right:1px solid #2b2b2b;");
  });

  it("text and label are there; no <pre>", () => {
    expect(html).toContain("Explorer");
    expect(html).toContain('aria-label="Editor"');
    expect(html).not.toContain("<pre");
  });
});
