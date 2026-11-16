import { describe, expect, it } from "vitest";
import { differencePixels } from "./pixel-difference";

describe("pixel difference", () => {
  it("reports absolute RGB channel changes with an opaque result", () => {
    const left = new Uint8ClampedArray([255, 0, 20, 255]);
    const right = new Uint8ClampedArray([0, 255, 10, 255]);
    expect([...differencePixels(left, right)]).toEqual([255, 255, 10, 255]);
  });

  it("compares transparent pixels over a consistent white background", () => {
    const transparent = new Uint8ClampedArray([0, 0, 0, 0]);
    const white = new Uint8ClampedArray([255, 255, 255, 255]);
    expect([...differencePixels(transparent, white)]).toEqual([0, 0, 0, 255]);
  });

  it("rejects mismatched pixel buffers", () => {
    expect(() =>
      differencePixels(new Uint8ClampedArray(4), new Uint8ClampedArray(8)),
    ).toThrow(/do not match/i);
  });
});
