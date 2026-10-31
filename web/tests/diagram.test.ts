import { describe, expect, it } from "vitest";
import { checkCanvasSafe } from "../src/core/canvas";
import { diagramRows, renderDiagram, type Diagram } from "../src/core/diagram";

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

  it("draws the nodes as cards in flow order, with each arrow and a text-description dropdown", () => {
    const html = renderDiagram(flowchart, "Flowchart", null);
    expect(html.indexOf(">Start<")).toBeLessThan(html.indexOf(">Button pressed?<"));
    expect(html).toContain("→ <strong>yes:</strong> Turn on LED");
    expect(html).toContain("↩ <strong>no:</strong> Start");
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Text description<\/summary>/);
    expect(html).not.toMatch(/<(?:table|svg)\b|position:/i);
  });

  it("rows follow the flow, or the screenshot's own rows when nodes have boxes", () => {
    expect(diagramRows(flowchart)).toEqual([["a"], ["b"], ["c"]]);
    const boxed: Diagram = {
      summary: "s",
      nodes: [
        { id: "o", label: "Order", shape: "entity", box: { x: 400, y: 40, width: 200, height: 200 } },
        { id: "c", label: "Customer", shape: "entity", box: { x: 20, y: 60, width: 200, height: 160 } },
        { id: "i", label: "Item", shape: "entity", box: { x: 400, y: 500, width: 200, height: 200 } },
      ],
      edges: [],
    };
    expect(diagramRows(boxed)).toEqual([["c", "o"], ["i"]]);
  });

  it("names an entity by its name in arrows and lists its attributes", () => {
    const html = renderDiagram({
      summary: "s",
      nodes: [{ id: "c", label: "Customer: id, name", shape: "entity" }, { id: "o", label: "Order: id", shape: "entity" }],
      edges: [{ from: "c", to: "o", label: "1..*" }],
    }, "L", null);
    expect(html).toContain("id<br>name");
    expect(html).toContain("→ <strong>1..*:</strong> Order</div>");
    expect(html).toContain("<li>Customer → Order (1..*)</li>");
  });

  it("escapes labels", () => {
    const html = renderDiagram({ summary: "<b>", nodes: [{ id: "x", label: "a < b", shape: "" }], edges: [] }, "L", null);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("a &lt; b");
  });
});

