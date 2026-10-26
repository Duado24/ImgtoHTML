/** Decode a chosen file into pixels, in the browser. GIFs use their final
 *  frame (earlier frames composited under it, as the viewer would see it). */

import { decompressFrames, parseGIF } from "gifuct-js";
import type { Pixels } from "../core/types";

export const SUPPORTED = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] as const;

export interface Decoded {
  canvas: HTMLCanvasElement;
  pixels: Pixels;
  animated: boolean;
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot read image pixels.");
  return { canvas, ctx };
}

/** Put the image on white, so transparent areas read as white
 *  rather than black. */
function flatten(canvas: HTMLCanvasElement): Decoded["canvas"] {
  const { canvas: out, ctx } = canvasOf(canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

async function decodeGif(buffer: ArrayBuffer): Promise<{ canvas: HTMLCanvasElement; animated: boolean }> {
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);
  if (frames.length === 0) throw new Error("This GIF has no frames.");

  const { canvas, ctx } = canvasOf(gif.lsd.width, gif.lsd.height);
  const { canvas: patchCanvas, ctx: patchCtx } = canvasOf(1, 1);

  let restore: ImageData | undefined;
  let previous: (typeof frames)[number] | undefined;

  for (const frame of frames) {
    // Undo the previous frame as its disposal method says.
    if (previous?.disposalType === 2) {
      const d = previous.dims;
      ctx.clearRect(d.left, d.top, d.width, d.height);
    } else if (previous?.disposalType === 3 && restore) {
      ctx.putImageData(restore, 0, 0);
    }
    restore = frame.disposalType === 3 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : undefined;

    const { width, height, left, top } = frame.dims;
    patchCanvas.width = width;
    patchCanvas.height = height;
    patchCtx.putImageData(new ImageData(new Uint8ClampedArray(frame.patch), width, height), 0, 0);
    ctx.drawImage(patchCanvas, left, top); // drawImage keeps transparent pixels see-through
    previous = frame;
  }

  return { canvas, animated: frames.length > 1 };
}

export async function decodeImage(file: File): Promise<Decoded> {
  let source: HTMLCanvasElement;
  let animated = false;

  if (/\.gif$/i.test(file.name) || file.type === "image/gif") {
    ({ canvas: source, animated } = await decodeGif(await file.arrayBuffer()));
  } else {
    // createImageBitmap applies EXIF rotation, like ImageOps.exif_transpose.
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      throw new Error("This browser can't open that image. Use PNG, JPG, GIF, WEBP or BMP.");
    }
    const { canvas, ctx } = canvasOf(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    source = canvas;
  }

  const canvas = flatten(source);
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  return { canvas, pixels: { width: data.width, height: data.height, data: data.data }, animated };
}
