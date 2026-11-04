/**
 * Identity and prefill (forms spec rules ID1, ID2, ID10). Precedence: customer session >
 * identity token `?pt=` (a staff-entry token is `staff`) > resume token > typed email at submit
 * > none. Tokens identify for prefill and linking only, never for portal access.
 */
import type { DbOrTx } from "@beam/db";
import { users } from "@beam/db/schema";
import type { FieldKey, FormDefinition, MapsTo } from "@beam/core/forms";
import { and, eq, type Ctx } from "@/lib/ctx";
import { getPerson, getPersonPrefill } from "@/modules/crm/api";
import { verifyIdentityToken, type IdentityClaims } from "./tokens";

export type IdentifiedBy = "session" | "token" | "staff" | "email" | "import" | "none";

export type Identity = { personId: string | null; identifiedBy: IdentifiedBy; staffUserId: string | null; claims: IdentityClaims | null };

/** `{ firstName, maskedEmail, known }` of ID2, plus the prefill values of the visible known fields. */
export type Prefill = {
  firstName: string | null;
  maskedEmail: string | null;
  known: FieldKey[];
  values: Partial<Record<FieldKey, string>>;
};

/** ID2: `j•••@gmail.com`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1) return null;
  return `${email[0]}•••${email.slice(at)}`;
}

/** The identity token claims when they are valid for this form (a token for another slug does not count). */
export function tokenFor(token: string | null | undefined, slug: string, now: Date): IdentityClaims | null {
  const claims = verifyIdentityToken(token, now);
  if (!claims) return null;
  if (claims.formSlug !== null && claims.formSlug !== slug) return null;
  return claims;
}

/** ID1 at start: session, then identity token (staff when it carries `s`), else none. */
export function resolveIdentity(ctx: Ctx, i: { identityToken?: string | null; slug: string }): Identity {
  if (ctx.actor.kind === "customer") return { personId: ctx.actor.personId, identifiedBy: "session", staffUserId: null, claims: null };
  const claims = tokenFor(i.identityToken, i.slug, ctx.now);
  if (claims) return { personId: claims.personId, identifiedBy: claims.staffUserId ? "staff" : "token", staffUserId: claims.staffUserId, claims };
  return { personId: null, identifiedBy: "none", staffUserId: null, claims: null };
}

/** ID10: the staff user of a staff-entry token must be an active staff user. */
export async function isActiveStaff(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.audience, "staff"), eq(users.status, "active")));
  return !!row;
}

const PREFILL_OF: Record<Exclude<MapsTo, "person.email">, "firstName" | "lastName" | "phone" | "birthOn"> = {
  "person.first_name": "firstName",
  "person.last_name": "lastName",
  "person.phone": "phone",
  "person.birth_on": "birthOn",
};

/** ID2: prefill from crm for the fields with `mapsTo`; `known` are the ones hidden by `skipKnownFields`. */
export async function buildPrefill(db: DbOrTx, def: FormDefinition, personId: string): Promise<Prefill> {
  const [p, person] = await Promise.all([getPersonPrefill(db, personId), getPerson(db, personId)]);
  const values: Partial<Record<FieldKey, string>> = {};
  const known: FieldKey[] = [];
  for (const f of Object.values(def.fields)) {
    if (!f.mapsTo) continue;
    const v = f.mapsTo === "person.email" ? (person?.email ?? null) : p[PREFILL_OF[f.mapsTo]];
    if (!v) continue;
    if (f.mapsTo !== "person.email") values[f.key] = v;
    if (def.settings.skipKnownFields) known.push(f.key);
  }
  return { firstName: p.firstName, maskedEmail: maskEmail(person?.email), known, values };
}

/** The answer keys by `mapsTo` target. */
export function mappedKeys(def: FormDefinition): Partial<Record<MapsTo, FieldKey>> {
  const out: Partial<Record<MapsTo, FieldKey>> = {};
  for (const f of Object.values(def.fields)) if (f.mapsTo && !out[f.mapsTo]) out[f.mapsTo] = f.key;
  return out;
}
