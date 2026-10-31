import { describe, expect, it } from "vitest";
import { checkCanvasSafe } from "../src/core/canvas";
import { renderDiagram, type Diagram } from "../src/core/diagram";

const flowchart: Diagram = {
  summary: "How a program checks a button press.",
  nodes: [
    { id: "a", label: "Start", shape: "start" },
    { id: "b", label: "Button pressed?", shape: "decision" },
    { id: "c", label: "Turn on LED", shape: "process" },
  ],
  edges: [
    { from: "a", to: "b", label: "" },
    { from: "b", to: "c", label: "yes" },
    { from: "b", to: "a", label: "no" },
  ],
};

describe("renderDiagram", () => {
  it("puts the summary, parts and connections in a closed Diagram Description dropdown", () => {
    const html = renderDiagram(flowchart, null);
    expect(html).toMatch(/^<details style="[^"]*border-radius:0\.75rem;[^"]*">\n {2}<summary[^>]*>Diagram Description<\/summary>/);
    expect(html).not.toMatch(/\bopen\b/);
    expect(html).toContain("How a program checks a button press.");
    expect(html).toContain("<li>Button pressed? (a yes/no question)</li>");
    expect(html).toContain("<li>Turn on LED</li>");
    expect(html).toContain("<li>From Button pressed? to Turn on LED, labeled “yes”</li>");
    expect(html).not.toMatch(/\((?:start|process)\)/);
    expect(html.trimEnd().endsWith("</details>")).toBe(true);
    expect(checkCanvasSafe(html)).toEqual([]);
  });

  it("keeps line breaks in parts and names connections by a label's first line", () => {
    const html = renderDiagram({
      summary: "s",
      nodes: [{ id: "a", label: "Import libraries:\nfrom gpiozero import Button", shape: "process" }, { id: "b", label: "End", shape: "end" }],
      edges: [{ from: "a", to: "b", label: "" }],
    }, null);
    expect(html).toContain("<li>Import libraries:<br>from gpiozero import Button</li>");
    expect(html).toContain("<li>From Import libraries: to End</li>");
  });

  it("leaves out parts without a label and connections to them", () => {
    const html = renderDiagram({
      summary: "s",
      nodes: [{ id: "pc", label: "Your Computer", shape: "process" }, { id: "icon", label: " ", shape: "note" }, { id: "gh", label: "GitHub", shape: "cloud" }],
      edges: [{ from: "pc", to: "icon", label: "" }, { from: "pc", to: "gh", label: "SSH" }],
    }, null);
    expect(html).not.toContain("<li> ");
    expect(html).not.toMatch(/ to <\/li>/);
    expect(html).toContain("<li>From Your Computer to GitHub, labeled “SSH”</li>");
  });

  it("lists parts under their headings, and the rest as other parts", () => {
    const html = renderDiagram({
      summary: "s",
      nodes: [
        { id: "h1", label: "What is Git?", shape: "heading" }, { id: "pc", label: "Your Computer", shape: "process", group: "h1" },
        { id: "h2", label: "What is GitHub?", shape: "heading" }, { id: "gh", label: "GitHub Repository", shape: "cloud", group: "h2" },
        { id: "pi", label: "Raspberry Pi", shape: "server" },
      ],
      edges: [],
    }, null);
    expect(html).toMatch(/<strong>What is Git\?<\/strong><\/p>\n {2}<ul[^>]*>\n {4}<li>Your Computer<\/li>/);
    expect(html).toMatch(/<strong>What is GitHub\?<\/strong><\/p>\n {2}<ul[^>]*>\n {4}<li>GitHub Repository<\/li>/);
    expect(html).toMatch(/<strong>Other parts<\/strong><\/p>\n {2}<ul[^>]*>\n {4}<li>Raspberry Pi<\/li>/);
    expect(html).not.toContain("<li>What is Git?</li>");
  });

  it("adds the caption after the dropdown and escapes text", () => {
    const html = renderDiagram({ summary: "<b>", nodes: [{ id: "x", label: "a < b", shape: "" }], edges: [] }, "Figure 1");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("a &lt; b");
    expect(html).toMatch(/<\/details>\n<p [^>]*>Figure 1<\/p>$/);
  });
});
