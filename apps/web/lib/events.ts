/**
 * Timeline events (`activity_events`, owned by crm; written only here). Each kind is declared
 * once with `defineEvent()` in its module's `events.ts`; `recordEvent()` validates the data
 * with the definition's Zod schema and the subject rule, and dedupes on `dedupe_key`.
 */
import type { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { activityEvents, type ActorJson } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import type { EventKind } from "../registry/types.generated";

export type EventSubject = "person" | "company" | "either";

export type EventDefinition<D extends z.ZodTypeAny = z.ZodTypeAny> = {
  kind: EventKind;
  data: D;
  isSensitive?: boolean;
  subject: EventSubject;
};

export function defineEvent<D extends z.ZodTypeAny>(def: {
  kind: EventKind;
  data: D;
  isSensitive?: boolean;
  subject: EventSubject;
}): EventDefinition<D> {
  return def;
}

export type RecordEventInput = {
  kind: EventKind;
  personId?: string;
  companyId?: string;
  occurredAt?: Date;
  data: unknown;
  ref?: { type: string; id: string };
  dedupeKey?: string;
  mode?: "live" | "replay" | "on_demand";
  isSensitive?: boolean;
};

let registry: Promise<Readonly<Record<string, EventDefinition | undefined>>> | undefined;
function loadEvents(): Promise<Readonly<Record<string, EventDefinition | undefined>>> {
  registry ??= import("../registry/events.generated").then(
    (m) => (m as { EVENTS?: unknown }).EVENTS as Readonly<Record<string, EventDefinition | undefined>>,
  );
  return registry;
}

/** The shape of `data` on an `is_sensitive` row: the encrypted body only. */
function isEncryptedBody(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const keys = Object.keys(data).sort();
  return keys.length === 2 && keys[0] === "body_enc" && keys[1] === "key_version";
}

/**
 * Inserts one `activity_events` row. Returns `{ id: null }` when `dedupeKey` already exists.
 * Throws `PermanentError` for an unknown kind, data that fails the schema, or a missing subject.
 */
export async function recordEvent(tx: DbOrTx, actor: ActorJson, input: RecordEventInput): Promise<{ id: bigint | null }> {
  const def = (await loadEvents())[input.kind];
  if (!def) throw new PermanentError(`unknown_event_kind: ${input.kind}`);
  const isSensitive = input.isSensitive ?? def.isSensitive ?? false;

  let data: unknown;
  if (isSensitive) {
    if (!isEncryptedBody(input.data)) throw new PermanentError(`event_data_not_encrypted: ${input.kind}`);
    data = input.data;
  } else {
    const parsed = def.data.safeParse(input.data ?? {});
    if (!parsed.success) throw new PermanentError(`invalid_event_data: ${input.kind}: ${parsed.error.message}`);
    data = parsed.data;
  }

  const hasPerson = !!input.personId;
  const hasCompany = !!input.companyId;
  if (def.subject === "person" && !hasPerson) throw new PermanentError(`event_subject_required: ${input.kind} needs personId`);
  if (def.subject === "company" && !hasCompany) throw new PermanentError(`event_subject_required: ${input.kind} needs companyId`);
  if (def.subject === "either" && !hasPerson && !hasCompany) {
    throw new PermanentError(`event_subject_required: ${input.kind} needs personId or companyId`);
  }

  const rows = await tx
    .insert(activityEvents)
    .values({
      kind: input.kind,
      personId: input.personId ?? null,
      companyId: input.companyId ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      mode: input.mode ?? null,
      isSensitive,
      actor,
      refType: input.ref?.type ?? null,
      refId: input.ref?.id ?? null,
      data: data as Record<string, unknown>,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: activityEvents.dedupeKey })
    .returning({ id: activityEvents.id });
  return { id: rows[0]?.id ?? null };
}
