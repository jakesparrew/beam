/**
 * forms-P5 QR codes: the SVG encodes `<origin>/<locale>/f/<slug>?l=<key>` (the text is read back
 * from the `qrcode` segment output and the SVG equals the rendering of exactly that text), and the
 * PNG bytes start with the PNG signature.
 */
import QRCode from "qrcode";
import { beforeAll, describe, expect, it } from "vitest";
import { newLinkKey, qrFileName, qrPng, qrSvg, QR_OPTIONS, trackedLinkUrl } from "./qr";

beforeAll(() => {
  process.env.APP_URL = "https://app.example.com/";
});

describe("tracked link QR codes", () => {
  it("builds the tracked URL per locale", () => {
    expect(trackedLinkUrl({ slug: "recovery-check", locale: "fr-BE", key: "ab12cd34" })).toBe("https://app.example.com/fr/f/recovery-check?l=ab12cd34");
    expect(trackedLinkUrl({ slug: "contact", locale: "nl-BE", key: "zz99yy88" })).toBe("https://app.example.com/nl/f/contact?l=zz99yy88");
  });

  it("the SVG encodes <origin>/<locale>/f/<slug>?l=<key>", async () => {
    const url = trackedLinkUrl({ slug: "recovery-check", locale: "en", key: "k3y4l1nk" });
    const code = QRCode.create(url, QR_OPTIONS);
    const decoded = code.segments.map((s) => String((s as { data: unknown }).data instanceof Uint8Array ? Buffer.from((s as { data: Uint8Array }).data).toString() : (s as { data: unknown }).data)).join("");
    expect(decoded).toBe("https://app.example.com/en/f/recovery-check?l=k3y4l1nk");
    expect(code.errorCorrectionLevel.bit).toBe(QRCode.create("x", { errorCorrectionLevel: "M" }).errorCorrectionLevel.bit);

    const svg = await qrSvg(url);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toBe(await QRCode.toString(url, { ...QR_OPTIONS, type: "svg" }));
    expect(svg).not.toBe(await qrSvg(`${url}x`));
  });

  it("PNG bytes start with the PNG signature and are 1024 px wide", async () => {
    const png = await qrPng(trackedLinkUrl({ slug: "contact", locale: "nl-BE", key: "abcdefgh" }));
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = Buffer.from(png).readUInt32BE(16);
    expect(width).toBe(1024);
  });

  it("link keys are 8 characters [a-z0-9] and file names carry slug and key", () => {
    for (let i = 0; i < 50; i++) expect(newLinkKey()).toMatch(/^[a-z0-9]{8}$/);
    expect(qrFileName("contact", "abcdefgh", "png")).toBe("contact-abcdefgh.png");
  });
});
