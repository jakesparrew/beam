/**
 * The immutability guard of `email_template_versions` (email spec rules 9 to 11; data model
 * rule 7). Pure. A row whose `published_at` is set is never updated: every write calls
 * `assertDraftVersion()` first, and editing a published template inserts a new draft
 * `version = max + 1` copied from the current version.
 */
import { PermanentError } from "../errors";

/** A write touched a published (immutable) template version. */
export class PublishedVersionError extends PermanentError {
  override readonly name: string = "PublishedVersionError";
  readonly code = "version_published" as const;
  readonly versionId: string | null;
  constructor(versionId: string | null) {
    super(`version_published: ${versionId ?? "unknown"}`);
    this.versionId = versionId;
  }
}

export type VersionRowLike = { id?: string | null; publishedAt: Date | string | null | undefined };

/** Throws `PublishedVersionError` unless the row is the editable draft (`published_at is null`). */
export function assertDraftVersion(row: VersionRowLike | null | undefined): void {
  if (!row) throw new PublishedVersionError(null);
  if (row.publishedAt !== null && row.publishedAt !== undefined) throw new PublishedVersionError(row.id ?? null);
}

export function isDraftVersion(row: VersionRowLike): boolean {
  return row.publishedAt === null || row.publishedAt === undefined;
}

/** The version number of the next draft: `max + 1`, or 1 for a template without versions. */
export function nextVersionNumber(existing: readonly number[]): number {
  return existing.length ? Math.max(...existing) + 1 : 1;
}

export type VersionContent<S = unknown, D = unknown, C = unknown> = {
  subject: S;
  preheader: S;
  document: D;
  copy: C;
  reactComponent: string | null;
};

/**
 * The columns of a new draft copied from `current` (rule 11). Compiled HTML and text, locales and
 * the publish moment are not copied: they are written again at publish.
 */
export function draftCopyOf<S, D, C>(current: VersionContent<S, D, C>, version: number): VersionContent<S, D, C> & { version: number; publishedAt: null } {
  const clone = <V>(v: V): V => (v === null || v === undefined ? v : structuredClone(v));
  return {
    subject: clone(current.subject),
    preheader: clone(current.preheader),
    document: clone(current.document),
    copy: clone(current.copy),
    reactComponent: current.reactComponent,
    version,
    publishedAt: null,
  };
}

/** `draftUpdatedAt` optimistic check of a draft: true when the client read the current row. */
export function draftIsCurrent(row: { updatedAt: Date }, draftUpdatedAt: Date | string): boolean {
  return row.updatedAt.getTime() === new Date(draftUpdatedAt).getTime();
}
