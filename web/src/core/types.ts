/** Shared shapes. Kept small and named, so positions, sizes and colors
 *  can't be passed where another kind of number is expected. */

/** An sRGB color, each channel 0–255. */
export type RGB = readonly [r: number, g: number, b: number];

/** A rectangle: left, top, width, height. Report boxes use a 0–1000 grid. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const KINDS = ["terminal", "code", "diagram", "interface"] as const;
export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
