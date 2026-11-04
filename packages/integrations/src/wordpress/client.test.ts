import { describe, expect, it } from "vitest";
import { IntegrationError } from "../_shared/errors";
import type { IntegrationCallEntry } from "../_shared/types";
import { WordpressMediaClient } from "./client";
import { createWordpressFake, fakePng } from "./fake";

const ORIGIN = "https://www.beam.example";

function setup(files: Parameters<typeof createWordpressFake>[0] = {}, extra: { cdnOrigins?: string[]; maxBytes?: number } = {}) {
  const log: IntegrationCallEntry[] = [];
  const fake = createWordpressFake(files);
  const client = fake.client({ allowedOrigin: ORIGIN, onCall: (e) => void log.push(e), ...extra });
  return { fake, client, log };
}

async function failure(p: Promise<unknown>): Promise<IntegrationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrationError);
    return e as IntegrationError;
  }
  throw new Error("expected a failure");
}

describe("WordpressMediaClient", () => {
  it("downloads an image from the site origin and logs the call without the body", async () => {
    const url = `${ORIGIN}/wp-content/uploads/2024/01/pool.png`;
    const { client, log } = setup({ [url]: { bytes: fakePng(8, 6) } });
    const media = await client.fetchMedia(url);
    expect(media).toMatchObject({ mime: "image/png", sizeBytes: 33 });
    expect(log).toEqual([expect.objectContaining({ provider: "wordpress", operation: "media.get", ok: true, statusCode: 200, error: null })]);
    expect(log[0]!.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(log)).not.toContain("pool.png");
  });

  it("refuses other origins, http and CDN paths outside uploads, without a request", async () => {
    const { client, fake, log } = setup({}, { cdnOrigins: ["https://cdn.beam.example"] });
    for (const url of ["https://evil.example/wp-content/uploads/a.png", "http://www.beam.example/a.png", "https://cdn.beam.example/secret/a.png", "https://user:pw@www.beam.example/a.png"]) {
      expect((await failure(client.fetchMedia(url))).code).toBe("origin_refused");
    }
    expect(fake.calls).toHaveLength(0);
    expect(log).toHaveLength(0);
    expect(client.allows("https://cdn.beam.example/wp-content/uploads/2024/a.png")).toBe(true);
  });

  it("enforces the size cap from the header and from the body", async () => {
    const big = `${ORIGIN}/wp-content/uploads/big.png`;
    const sneaky = `${ORIGIN}/wp-content/uploads/sneaky.png`;
    const { client, log } = setup({ [big]: { contentLength: 50 }, [sneaky]: { bytes: new Uint8Array(64) } }, { maxBytes: 40 });
    const e1 = await failure(client.fetchMedia(big));
    expect(e1).toMatchObject({ code: "too_large", retryable: false });
    expect((await failure(client.fetchMedia(sneaky))).code).toBe("too_large");
    expect(log.map((l) => l.ok)).toEqual([false, false]);
  });

  it("checks the mime type", async () => {
    const svg = `${ORIGIN}/wp-content/uploads/logo.svg`;
    const { client } = setup({ [svg]: { mime: "image/svg+xml" } });
    expect(await failure(client.fetchMedia(svg))).toMatchObject({ code: "mime_not_allowed", retryable: false });
  });

  it("maps 404 and 410 to a permanent media_missing and 5xx to a retryable error", async () => {
    const gone = `${ORIGIN}/wp-content/uploads/gone.png`;
    const down = `${ORIGIN}/wp-content/uploads/down.png`;
    const { client, log } = setup({ [gone]: { status: 410 }, [down]: { status: 503 } });
    expect(await failure(client.fetchMedia(`${ORIGIN}/missing.png`))).toMatchObject({ code: "media_missing", retryable: false, statusCode: 404 });
    expect(await failure(client.fetchMedia(gone))).toMatchObject({ code: "media_missing", statusCode: 410 });
    expect(await failure(client.fetchMedia(down))).toMatchObject({ retryable: true, statusCode: 503 });
    expect(log.map((l) => l.statusCode)).toEqual([404, 410, 503]);
  });

  it("turns a network failure into a retryable logged error", async () => {
    const log: IntegrationCallEntry[] = [];
    const client = new WordpressMediaClient({ allowedOrigin: ORIGIN, onCall: (e) => void log.push(e), fetch: () => Promise.reject(new Error("ECONNRESET")) });
    expect(await failure(client.fetchMedia(`${ORIGIN}/a.png`))).toMatchObject({ retryable: true });
    expect(log).toEqual([expect.objectContaining({ ok: false, statusCode: null })]);
  });

  it("requires an https allowedOrigin", () => {
    expect(() => new WordpressMediaClient({ allowedOrigin: "http://www.beam.example", onCall: () => undefined })).toThrow(TypeError);
  });
});
