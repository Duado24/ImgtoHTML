import { describe, expect, it } from "vitest";
import { plainLines } from "../src/core/paint";
import { render } from "../src/core/render";

const SAMPLE = [
  "Welcome to VitalLink! Let's get you signed up.",
  "",
  '    indented <tag> & "quotes"',
  "",
  "Thank you for signing up!",
];

const make = (caption?: string) =>
  render(plainLines(SAMPLE), "A label", [0x18, 0x18, 0x18], [0xcc, 0xcc, 0xcc], caption);

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
    const { styles } = linesOf(make());
    expect(styles.every((s) => s.includes("pre-wrap") && s.includes("text-indent:-2ch"))).toBe(true);
    expect(make()).not.toContain("overflow-x:auto");
  });

  it("code wraps every long line while preserving its whitespace", () => {
    const { styles } = linesOf(make());
    expect(styles.every((s) => s.includes("white-space:pre-wrap;") && s.includes("overflow-wrap:anywhere;"))).toBe(true);
    expect(make()).not.toContain("overflow:hidden;");
    expect(make()).not.toContain("overflow-x:auto");
  });

  it("caption outside the text box", () => {
    const fragment = make("Animated in the original.");
    expect(fragment).toContain("Animated in the original.</p>");
    expect(fragment.indexOf("Thank you")).toBeLessThan(fragment.indexOf("<p "));
  });

  it("label is escaped inside the attribute", () => {
    const fragment = render(plainLines(["x"]), 'Say "hi" & <go>', [0, 0, 0], [255, 255, 255]);
    expect(fragment).toContain('aria-label="Say &quot;hi&quot; &amp; &lt;go&gt;"');
  });

  it("colored runs become spans; the box's own text color doesn't", () => {
    const fragment = render(
      [{ runs: [{ text: "print", color: [0xdc, 0xdc, 0xaa] }, { text: "(", color: [0xcc, 0xcc, 0xcc] }, { text: '"hi"', color: [0xce, 0x91, 0x78] }, { text: ")" }] }],
      "A label", [0x18, 0x18, 0x18], [0xcc, 0xcc, 0xcc],
    );
    expect(fragment).toContain(
      '<span style="color:#dcdcaa;">print</span>(<span style="color:#ce9178;">&quot;hi&quot;</span>)',
    );
  });
});

