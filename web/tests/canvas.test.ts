import { describe, expect, it } from "vitest";
import { checkCanvasSafe } from "../src/core/canvas";
import { plainLines } from "../src/core/paint";
import { render } from "../src/core/render";

const messages = (html: string) => checkCanvasSafe(html).map((i) => `${i.level}: ${i.message}`);

describe("checkCanvasSafe", () => {
  it("accepts the renderer's output for every kind", () => {
    for (const kind of ["terminal", "code", "diagram", "interface"] as const) {
      const html = render(plainLines(["$ ls -la", "", "total 8"]), kind, "Terminal listing", [0, 0, 0], [255, 255, 255], "A caption");
      expect(checkCanvasSafe(html)).toEqual([]);
    }
  });

  it("rejects elements Canvas removes, and <pre>", () => {
    expect(messages("<style>p{}</style><script>x()</script><pre>a</pre>")).toEqual([
      "error: <style> is not allowed",
      "error: <script> is not allowed",
      "error: <pre> is not allowed",
    ]);
  });

  it("rejects event handlers and script URLs", () => {
    expect(messages('<a href="javascript:alert(1)" onclick="x()">x</a>')).toEqual([
      "error: <a> href uses a script or data URL",
      "error: <a> has an event handler (onclick)",
    ]);
  });

  it("warns about CSS properties and classes that may not survive", () => {
    expect(messages('<div class="x" style="color:red;transform:rotate(1deg);position:absolute">x</div>')).toEqual([
      "warning: class has no effect without a stylesheet; use inline styles",
      'warning: <div> style "transform" may be stripped by Canvas',
      "error: <div> uses position:absolute, which Canvas removes",
    ]);
  });

  it("requires alt text and figure labels", () => {
    expect(messages('<div role="figure"><img src="a.png"></div>')).toEqual([
      'error: role="figure" without an accessible name (aria-label)',
      "error: <img> without alt text",
    ]);
  });

  it("lists each problem once and ignores comments", () => {
    expect(messages("<!-- <script> --><pre>a</pre><pre>b</pre>")).toEqual(["error: <pre> is not allowed"]);
  });
});
