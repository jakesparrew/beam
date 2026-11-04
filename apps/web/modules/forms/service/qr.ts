/**
 * Tracked-link URLs and QR codes (forms spec sections 2 `form_links` and 5 `/admin/forms/[formId]/links`;
 * forms-P5). A tracked link is the hosted form URL `<origin>/<locale>/f/<slug>?l=<key>`; its QR
 * code is an SVG or a 1024 px PNG with error correction level M (`qrcode`, installed in Wave 0).
 */
import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import type { Locale } from "@beam/core/i18n";
import { hostedFormUrl } from "./tokens";

/** QR rendering options shared by both formats (spec: 1024 px, error correction M). */
export const QR_OPTIONS = { errorCorrectionLevel: "M", margin: 2 } as const;
export const QR_PNG_WIDTH = 1024;

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new link key: 8 characters `[a-z0-9]` (`form_links.key`). */
export function newLinkKey(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return out;
}

/** The absolute URL of a tracked link: `<origin>/<locale>/f/<slug>?l=<key>`. */
export function trackedLinkUrl(i: { slug: string; locale: Locale; key: string }): string {
  return hostedFormUrl(i.slug, i.locale, { l: i.key });
}

/** The QR code of `text` as a standalone SVG document. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { ...QR_OPTIONS, type: "svg" });
}

/** The QR code of `text` as PNG bytes, 1024 px wide. */
export async function qrPng(text: string): Promise<Uint8Array> {
  const buf = await QRCode.toBuffer(text, { ...QR_OPTIONS, type: "png", width: QR_PNG_WIDTH });
  return new Uint8Array(buf);
}

/** A download file name for a link's QR code (`<slug>-<key>.svg|png`). */
export function qrFileName(slug: string, key: string, format: "svg" | "png"): string {
  return `${slug}-${key}.${format}`;
}
