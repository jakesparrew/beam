import { describe, expect, it } from "vitest";
import { imageSize } from "./image-size";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

describe("imageSize", () => {
  it("PNG", () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(640), be32(480), [8, 6, 0, 0, 0]);
    expect(imageSize(png)).toEqual({ width: 640, height: 480, mime: "image/png" });
  });

  it("JPEG (skips APP0 to the SOF0 frame)", () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...bytes("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const jpeg = bytes([0xff, 0xd8], app0, sof0, [0xff, 0xd9]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600, mime: "image/jpeg" });
  });

  it("GIF", () => {
    expect(imageSize(bytes("GIF89a", le16(320), le16(200), [0, 0, 0]))).toEqual({ width: 320, height: 200, mime: "image/gif" });
    expect(imageSize(bytes("GIF87a", le16(1), le16(1), [0, 0, 0]))).toEqual({ width: 1, height: 1, mime: "image/gif" });
  });

  it("WebP lossy, lossless and extended", () => {
    const lossy = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(1024), le16(768));
    expect(imageSize(lossy)).toEqual({ width: 1024, height: 768, mime: "image/webp" });
    const w = 400 - 1;
    const h = 300 - 1;
    const bits = w | (h << 14);
    const lossless = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], [0, 0, 0, 0, 0]);
    expect(imageSize(lossless)).toEqual({ width: 400, height: 300, mime: "image/webp" });
    const extended = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0, 0, 0, 0], le24(1919), le24(1079), [0, 0]);
    expect(imageSize(extended)).toEqual({ width: 1920, height: 1080, mime: "image/webp" });
  });

  it("SVG, AVIF and garbage return null", () => {
    expect(imageSize(bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))).toBeNull();
    const avif = bytes(be32(32), "ftypavif", be32(0), "avifmif1miaf", [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(avif)).toBeNull();
    expect(imageSize(new Uint8Array([]))).toBeNull();
    expect(imageSize(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
