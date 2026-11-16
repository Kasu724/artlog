import type { Preview } from "../types";

export const MAX_DIFFERENCE_EDGE = 1024;

/** Compute a channel-wise difference after compositing both sources over white. */
export function differencePixels(
  left: Uint8ClampedArray,
  right: Uint8ClampedArray,
): Uint8ClampedArray {
  if (left.length !== right.length || left.length % 4 !== 0) {
    throw new Error("Preview pixel buffers do not match.");
  }
  const output = new Uint8ClampedArray(left.length);
  for (let offset = 0; offset < left.length; offset += 4) {
    const leftAlpha = left[offset + 3] / 255;
    const rightAlpha = right[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const leftOnWhite = Math.round(
        left[offset + channel] * leftAlpha + 255 * (1 - leftAlpha),
      );
      const rightOnWhite = Math.round(
        right[offset + channel] * rightAlpha + 255 * (1 - rightAlpha),
      );
      output[offset + channel] = Math.abs(leftOnWhite - rightOnWhite);
    }
    output[offset + 3] = 255;
  }
  return output;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("ArtLog could not decode one of these previews."));
    image.src = dataUrl;
  });
}

export async function createPixelDifference(
  left: Preview,
  right: Preview,
): Promise<{ dataUrl: string; width: number; height: number }> {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(
      "Pixel difference needs previews with the same dimensions.",
    );
  }
  const scale = Math.min(
    1,
    MAX_DIFFERENCE_EDGE / Math.max(left.width, left.height),
  );
  const width = Math.max(1, Math.round(left.width * scale));
  const height = Math.max(1, Math.round(left.height * scale));
  const [leftImage, rightImage] = await Promise.all([
    loadImage(left.dataUrl),
    loadImage(right.dataUrl),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("ArtLog could not prepare the preview comparison.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(leftImage, 0, 0, width, height);
  const leftPixels = context.getImageData(0, 0, width, height).data;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(rightImage, 0, 0, width, height);
  const rightPixels = context.getImageData(0, 0, width, height).data;
  const difference = context.createImageData(width, height);
  difference.data.set(differencePixels(leftPixels, rightPixels));
  context.putImageData(difference, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}
