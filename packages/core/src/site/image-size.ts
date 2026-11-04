/**
 * Image dimensions from the file header (media upload, WordPress media). Only the four mimes of
 * platform's `files_mime_ck` are accepted: PNG, JPEG, WebP and GIF. Anything else (SVG, AVIF, a
 * broken file) returns null and the upload is refused.
 */
export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type ImageSize = { width: number; height: number; mime: ImageMime };

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

const ok = (width: number, height: number, mime: ImageMime): ImageSize | null =>
  width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height, mime } : null;

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== "IHDR") return null;
  return ok(u32be(b, 16), u32be(b, 20), "image/png");
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null;
  const head = ascii(b, 0, 6);
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  return ok(u16le(b, 6), u16le(b, 8), "image/gif");
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff, "image/webp");
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "image/webp");
  }
  if (chunk === "VP8X") return ok(u24le(b, 24) + 1, u24le(b, 27) + 1, "image/webp");
  return null;
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 3 < b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1]!;
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 8 >= b.length) return null;
      return ok(u16be(b, o + 7), u16be(b, o + 5), "image/jpeg");
    }
    o += 2 + len;
  }
  return null;
}

/** Width, height and mime from the header bytes, or null for any other format. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}
