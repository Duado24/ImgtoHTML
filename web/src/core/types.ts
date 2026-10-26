/** Shared shapes. Kept small and named, so pixel positions, sizes and
 *  colors can't be passed where another kind of number is expected. */

/** An sRGB color, each channel 0–255. */
export type RGB = readonly [r: number, g: number, b: number];

/** A rectangle in image pixels: left, top, width, height. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Decoded image pixels, RGBA, row by row (same layout as ImageData). */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** One character's box, as the OCR engine reports it. */
export interface OcrSymbol extends Box {
  readonly text: string;
}

/** One word as the OCR engine reports it. */
export interface OcrWord extends Box {
  /** Per-character boxes, when the engine gives them (used for colors). */
  readonly symbols?: readonly OcrSymbol[];
  readonly text: string;
  /** 0–100, or -1 when unknown. */
  readonly confidence: number;
  /** Which block / paragraph / line the word belongs to. */
  readonly block: number;
  readonly paragraph: number;
  readonly line: number;
}

/** OCR often "reads" an icon (◆ ⊘ ⌄) or a separator line as a short,
 *  uncertain, letterless "word" such as "~~", "¢" or "*". */
export function isIconNoise(word: OcrWord): boolean {
  return word.confidence < 70 && [...word.text].length <= 2 && !/[\p{L}\p{N}]/u.test(word.text);
}

export const KINDS =["terminal", "code", "diagram", "interface"] as const;
export type Kind = (typeof KINDS)[number];

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}
