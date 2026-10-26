import { describe, expect, it } from "vitest";
import { render } from "../src/core/render";
import type { Kind } from "../src/core/types";

const SAMPLE = [
  "Welcome to VitalLink! Let's get you signed up.",
  "",
  '    indented <tag> & "quotes"',
  "",
  "Thank you for signing up!",
];

const make = (kind: Kind = "terminal", caption?: string) =>
  render(SAMPLE, kind, "A label", [0x18, 0x18, 0x18], [0xcc, 0xcc, 0xcc], caption);

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
    const fragment = render(["x"], "terminal", 'Say "hi" & <go>', [0, 0, 0], [255, 255, 255]);
    expect(fragment).toContain('aria-label="Say &quot;hi&quot; &amp; &lt;go&gt;"');
  });
});
