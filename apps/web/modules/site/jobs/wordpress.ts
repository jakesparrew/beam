/**
 * WordPress import jobs (site spec section 4, rules 52-53, 64-66; site-P7): `site.parse_wordpress`,
 * `site.fetch_wordpress_media` and `site.apply_wordpress`. The work lives in
 * `server/wordpress/apply.ts`; these handlers check the import's state, run one step and enqueue the
 * next one in the same transaction. A second run of any of them changes nothing.
 *
 * Order: the action enqueues `apply` offset 0; its first run of a round inserts the `/feed`
 * redirect (round 0) and enqueues `media` (n = 0 in round 0, the next unused n after a retry). Pages
 * need their images in the media library before they are converted, so an apply chunk that finds
 * attachments still waiting re-enqueues itself a minute later (key suffix `:w<n>`, at most
 * `MAX_MEDIA_WAITS` times; then the missing attachments become `error` "media missing" and the
 * import goes on, and `retryImportErrors` fetches them again in a new round).
 */
import { z } from "zod";
import { IntegrationError, isPermanentFailure } from "@beam/integrations/_shared";
import { WordpressMediaClient } from "@beam/integrations/wordpress";
import { imageSize } from "@beam/core/site";
import { PermanentError, RetryableError, type JobCtx } from "@/lib/job-runner";
import { readFile, storeFile } from "@/lib/files";
import { parseWxr, wxrCdnOrigins } from "../server/wordpress/wxr";
import {
  applyImportChunk,
  applyJobKey,
  finishImportIfComplete,
  getImportRow,
  giveUpPendingMedia,
  importMediaChunk,
  insertFeedRedirect,
  itemCounts,
  lockImport,
  mediaJobKey,
  patchImport,
  pendingMediaCount,
  reportOf,
  storeWxrItems,
  type MediaFetcher,
} from "../server/wordpress/apply";

type DeadError = { message: string; permanent: boolean };

export const ParseWordpressInput = z.object({ importId: z.string().uuid() });
export type ParseWordpressInput = z.infer<typeof ParseWordpressInput>;

export const FetchWordpressMediaInput = z.object({ importId: z.string().uuid(), n: z.number().int().min(0) });
export type FetchWordpressMediaInput = z.infer<typeof FetchWordpressMediaInput>;

/**
 * `round` = number of `retryImportErrors` calls (0 first), part of the idempotency key. `wait`
 * counts the re-enqueues of a chunk that waits for media (0 for the chunk itself).
 */
export const ApplyWordpressInput = z.object({
  importId: z.string().uuid(),
  offset: z.number().int().min(0),
  round: z.number().int().min(0),
  wait: z.number().int().min(0).default(0),
});
export type ApplyWordpressInput = z.infer<typeof ApplyWordpressInput>;

/** One-minute waits for media before an apply chunk gives up on missing attachments (2 hours). */
export const MAX_MEDIA_WAITS = 120;
export const MEDIA_WAIT_MS = 60_000;

/** Test seam: tests install a factory that returns a client backed by the WordPress fake. */
type MediaClientFactory = (opts: { allowedOrigin: string; cdnOrigins: readonly string[]; ctx: JobCtx }) => MediaFetcher;
const realFactory: MediaClientFactory = ({ allowedOrigin, cdnOrigins, ctx }) =>
  new WordpressMediaClient({ allowedOrigin, cdnOrigins, onCall: (entry) => ctx.integrationLog(entry) });
let mediaClientFactory: MediaClientFactory = realFactory;

/** Replaces the client factory (tests); `undefined` restores the real client. */
export function setWordpressMediaClientFactory(factory: MediaClientFactory | undefined): void {
  mediaClientFactory = factory ?? realFactory;
}

const lineOf = (message: string): number => Number(/line (\d+)/.exec(message)?.[1] ?? 0);

// ---------------------------------------------------------------------------------------------
// site.parse_wordpress
// ---------------------------------------------------------------------------------------------

export async function parseWordpress(ctx: JobCtx, input: ParseWordpressInput): Promise<unknown> {
  const imp = await lockImport(ctx.tx, input.importId);
  if (!imp) return { outcome: "skipped", reason: "import_missing" };
  if (imp.status !== "uploaded" && imp.status !== "parsing") return { outcome: "skipped", reason: `status_${imp.status}` };
  await patchImport(ctx.tx, imp, { status: "parsing" }, ctx.now);

  const file = await readFile(ctx.tx, imp.fileId);
  if (!file) throw new PermanentError("wxr_missing: line 0: the uploaded file is gone");
  const xml = new TextDecoder("utf-8").decode(file.bytes);
  const { items, errors } = parseWxr(xml);
  if (!items.length && errors.length) throw new PermanentError(`wxr_invalid: line ${errors[0]!.line}: ${errors[0]!.message}`.slice(0, 500));

  await storeWxrItems(ctx.tx, imp.id, items);
  const fresh = (await getImportRow(ctx.tx, imp.id))!;
  await patchImport(
    ctx.tx,
    fresh,
    { status: "parsed", counts: await itemCounts(ctx.tx, imp.id), report: { parseErrors: errors.slice(0, 100), cdnOrigins: wxrCdnOrigins(items, imp.siteOrigin) } },
    ctx.now,
  );
  return { outcome: "parsed", items: items.length, errors: errors.length };
}

/** A dead parse (invalid XML, missing file) sets the import `failed` with the parser's line. */
export async function onParseWordpressDead(ctx: JobCtx, input: ParseWordpressInput, error: DeadError): Promise<void> {
  const imp = await lockImport(ctx.tx, input.importId);
  if (!imp || (imp.status !== "uploaded" && imp.status !== "parsing")) return;
  const message = error.message.replace(/^(PermanentError: )?wxr_(invalid|missing): line \d+: /, "").slice(0, 500);
  await patchImport(ctx.tx, imp, { status: "failed", report: { parseError: { line: lineOf(error.message), message } } }, ctx.now);
}

// ---------------------------------------------------------------------------------------------
// site.fetch_wordpress_media
// ---------------------------------------------------------------------------------------------

export async function fetchWordpressMedia(ctx: JobCtx, input: FetchWordpressMediaInput): Promise<unknown> {
  const imp = await getImportRow(ctx.tx, input.importId);
  if (!imp) return { outcome: "skipped", reason: "import_missing" };
  if (imp.status !== "applying") return { outcome: "skipped", reason: `status_${imp.status}` };
  const fetcher = mediaClientFactory({ allowedOrigin: imp.siteOrigin, cdnOrigins: reportOf(imp).cdnOrigins ?? [], ctx });
  let result: { processed: number; remaining: number };
  try {
    result = await importMediaChunk(ctx.tx, ctx, imp.id, {
      fetcher,
      store: (f) => storeFile(ctx, { kind: "image", name: f.name, mime: f.mime, bytes: f.bytes, isPublic: true }),
      size: imageSize,
      isRetryable: (e) => e instanceof IntegrationError && !isPermanentFailure(e),
      codeOf: (e) => (e instanceof IntegrationError ? (e.code ?? null) : null),
    });
  } catch (e) {
    if (e instanceof IntegrationError && e.retryable) throw new RetryableError(e.message, { cause: e });
    throw e;
  }
  const locked = (await lockImport(ctx.tx, imp.id))!;
  const mediaNext = Math.max(reportOf(locked).mediaNext ?? 0, input.n + 1);
  await patchImport(ctx.tx, locked, { report: { mediaNext } }, ctx.now);
  if (result.remaining > 0 && result.processed > 0) {
    await ctx.enqueue({ kind: "site.fetch_wordpress_media", payload: { importId: imp.id, n: input.n + 1 }, key: mediaJobKey(imp.id, input.n + 1) });
  }
  return { outcome: "fetched", processed: result.processed, remaining: result.remaining };
}

// ---------------------------------------------------------------------------------------------
// site.apply_wordpress
// ---------------------------------------------------------------------------------------------

export async function applyWordpress(ctx: JobCtx, input: ApplyWordpressInput): Promise<unknown> {
  let imp = await lockImport(ctx.tx, input.importId);
  if (!imp) return { outcome: "skipped", reason: "import_missing" };
  if (imp.status !== "parsed" && imp.status !== "applying") return { outcome: "skipped", reason: `status_${imp.status}` };
  const report = reportOf(imp);
  if ((report.round ?? 0) !== input.round) return { outcome: "skipped", reason: "stale_round" };
  if (imp.status === "parsed") imp = await patchImport(ctx.tx, imp, { status: "applying" }, ctx.now);

  if (input.offset === 0 && input.wait === 0) {
    if (input.round === 0) {
      const feed = await insertFeedRedirect(ctx.tx);
      if (feed) imp = await patchImport(ctx.tx, imp, { counts: { redirects: (imp.counts.redirects ?? 0) + feed } }, ctx.now);
    }
    const n = input.round === 0 ? 0 : (reportOf(imp).mediaNext ?? 0);
    await ctx.enqueue({ kind: "site.fetch_wordpress_media", payload: { importId: imp.id, n }, key: mediaJobKey(imp.id, n) });
  }

  if ((await pendingMediaCount(ctx.tx, imp.id)) > 0) {
    if (input.wait < MAX_MEDIA_WAITS) {
      const wait = input.wait + 1;
      await ctx.enqueue({
        kind: "site.apply_wordpress",
        payload: { importId: imp.id, offset: input.offset, round: input.round, wait },
        key: applyJobKey(imp.id, input.offset, input.round, wait),
        runAt: new Date(ctx.now.getTime() + MEDIA_WAIT_MS),
      });
      return { outcome: "waiting_media", wait };
    }
    await giveUpPendingMedia(ctx.tx, ctx, imp.id);
  }

  const { next } = await applyImportChunk(ctx.tx, ctx, imp.id, input.offset);
  if (next !== null) {
    await ctx.enqueue({ kind: "site.apply_wordpress", payload: { importId: imp.id, offset: next, round: input.round }, key: applyJobKey(imp.id, next, input.round) });
    return { outcome: "applied", next };
  }
  const done = await finishImportIfComplete(ctx.tx, ctx, imp.id);
  return { outcome: done ? "done" : "applied", next: null };
}

/** A dead apply chunk sets the import `failed` (rule 66). */
export async function onApplyWordpressDead(ctx: JobCtx, input: ApplyWordpressInput, error: DeadError): Promise<void> {
  const imp = await lockImport(ctx.tx, input.importId);
  if (!imp || imp.status !== "applying" || (reportOf(imp).round ?? 0) !== input.round) return;
  await patchImport(ctx.tx, imp, { status: "failed", report: { lastError: error.message.slice(0, 500) }, counts: await itemCounts(ctx.tx, imp.id) }, ctx.now);
}

