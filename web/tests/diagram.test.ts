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
  it("writes the summary, parts and connections as Canvas-safe HTML", () => {
    const html = renderDiagram(flowchart, "Flowchart of the button program", null);
    expect(html).toContain("How a program checks a button press.");
    expect(html).toContain("<li>Button pressed? (decision)</li>");
    expect(html).toContain("<li>Turn on LED</li>");
    expect(html).toContain("<li>Button pressed? → Turn on LED (yes)</li>");
    expect(checkCanvasSafe(html)).toEqual([]);
  });

  it("keeps line breaks in parts and names connections by a label's first line", () => {
    const html = renderDiagram({
      summary: "s",
      nodes: [{ id: "a", label: "Import libraries:\nfrom gpiozero import Button", shape: "process" }, { id: "b", label: "End", shape: "end" }],
      edges: [{ from: "a", to: "b", label: "" }],
    }, "L", null);
    expect(html).toContain("<li>Import libraries:<br>from gpiozero import Button</li>");
    expect(html).toContain("<li>Import libraries: → End</li>");
  });

  it("escapes labels", () => {
    const html = renderDiagram({ summary: "<b>", nodes: [{ id: "x", label: "a < b", shape: "" }], edges: [] }, "L", null);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("a &lt; b");
  });
});

