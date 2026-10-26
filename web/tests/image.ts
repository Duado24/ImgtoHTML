/** Tiny raster helpers for building fake screenshots in tests. */

import type { Pixels, RGB } from "../src/core/types";

export class FakeImage implements Pixels {
  readonly data: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
    background: RGB,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    this.fill(0, 0, width - 1, height - 1, background);
  }

  set(x: number, y: number, [r, g, b]: RGB) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data.set([r, g, b, 255], i);
  }

  /** Filled rectangle, corners inclusive (like PIL's ImageDraw.rectangle). */
  fill(x0: number, y0: number, x1: number, y1: number, color: RGB) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, color);
  }

  /** One-pixel rectangle outline, corners inclusive. */
  outline(x0: number, y0: number, x1: number, y1: number, color: RGB) {
    for (let x = x0; x <= x1; x++) (this.set(x, y0, color), this.set(x, y1, color));
    for (let y = y0; y <= y1; y++) (this.set(x0, y, color), this.set(x1, y, color));
  }

  /** Ring inside the box (x0,y0)-(x1,y1), `thickness` pixels wide. */
  ring(x0: number, y0: number, x1: number, y1: number, thickness: number, color: RGB) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const outer = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        const inner = ((x - cx) / (rx - thickness)) ** 2 + ((y - cy) / (ry - thickness)) ** 2;
        if (outer <= 1 && inner >= 1) this.set(x, y, color);
      }
    }
  }
}
