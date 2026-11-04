/**
 * Fake WordPress media host for tests and fake-provider mode (runbook 1.5): a `fetch` stub that
 * answers from a map of URLs, used behind the real `WordpressMediaClient`, so origin, size and mime
 * rules behave exactly as in production. Unknown URLs answer 404. No network.
 */
import type { FakeCall, FetchLike, OnCall } from "../_shared/types";
import { WordpressMediaClient, type WordpressMediaClientOptions } from "./client";

export type FakeWordpressFile = { status?: number; mime?: string; bytes?: Uint8Array; contentLength?: number };

/** A minimal PNG header (signature + IHDR) with the given size; enough for `imageSize()`. */
export function fakePng(width = 4, height = 3): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  return out;
}

export type WordpressFake = {
  /** The `fetch` stub; pass it to `WordpressMediaClient` (`fetch` option). */
  fetch: FetchLike;
  /** Every request the stub answered. */
  calls: FakeCall<{ url: string }>[];
  /** Adds or replaces a URL's answer. */
  set(url: string, file: FakeWordpressFile): void;
  /** A client on `allowedOrigin` backed by this stub. */
  client(opts: { allowedOrigin: string; cdnOrigins?: readonly string[]; onCall?: OnCall; maxBytes?: number }): WordpressMediaClient;
};

export function createWordpressFake(files: Record<string, FakeWordpressFile> = {}): WordpressFake {
  const table = new Map<string, FakeWordpressFile>(Object.entries(files));
  const calls: FakeCall<{ url: string }>[] = [];
  const stub: FetchLike = (input) => {
    const url = String(input);
    calls.push({ operation: "media.get", input: { url }, at: new Date() });
    const file = table.get(url);
    if (!file) return Promise.resolve(new Response("not found", { status: 404 }));
    const status = file.status ?? 200;
    if (status >= 300) return Promise.resolve(new Response("error", { status }));
    const bytes = file.bytes ?? fakePng();
    const headers = new Headers({ "content-type": file.mime ?? "image/png" });
    if (file.contentLength !== undefined) headers.set("content-length", String(file.contentLength));
    return Promise.resolve(new Response(bytes, { status, headers }));
  };
  return {
    fetch: stub,
    calls,
    set: (url, file) => void table.set(url, file),
    client: (opts) => {
      const options: WordpressMediaClientOptions = { allowedOrigin: opts.allowedOrigin, onCall: opts.onCall ?? (() => undefined), fetch: stub };
      if (opts.cdnOrigins) options.cdnOrigins = opts.cdnOrigins;
      if (opts.maxBytes !== undefined) options.maxBytes = opts.maxBytes;
      return new WordpressMediaClient(options);
    },
  };
}
