import type { OcrWord } from "../../src/core/types";

export interface OcrImage {
  png: Buffer;
  width: number;
  height: number;
}

/** Boxes and block/paragraph/line ids are in the supplied image's coordinates.
 * Character boxes are optional, but both bundled engines supply them for colors.
 * Callers serialize requests to an engine and close it on server shutdown. */
export interface OcrEngine {
  recognize(image: OcrImage): Promise<OcrWord[]>;
  close?(): Promise<void>;
}
