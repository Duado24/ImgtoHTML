import { describe, expect, it } from "vitest";
import { addDiagram, convert, issuesFor } from "../src/core/convert";
import { checkCanvasSafe } from "../src/core/canvas";
import { renderDiagram, unconfirmedLabels, type Diagram } from "../src/core/diagram";
import { FakeImage } from "./image";

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

describe("unconfirmedLabels", () => {
  it("lists labels with words OCR never saw", () => {
    expect(unconfirmedLabels(flowchart, "Start Button pressed? Turn on LEO")).toEqual(["Turn on LED"]);
  });
});

describe("addDiagram", () => {
  it("replaces the OCR text box and tells the reviewer what to check", () => {
    const pixels = new FakeImage(100, 40, [255, 255, 255]);
    const base = convert({ fileName: "f.png", pixels, words: [], animated: false, kind: "diagram", label: "Button flowchart" });
    expect(issuesFor(base).some((i) => i.text.includes("needs the vision model"))).toBe(true);
    const result = addDiagram(base, flowchart);
    expect(result.html).toContain('aria-label="Button flowchart"');
    expect(result.htmlFile.content).toBe(result.html);
    expect(result.review.diagram).toEqual({ parts: 3, connections: 3, unconfirmed_labels: ["Start", "Button pressed?", "Turn on LED"] });
    expect(issuesFor(result).map((i) => i.level)).toEqual(expect.arrayContaining(["info", "warn"]));
  });
});
