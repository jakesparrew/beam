/**
 * Local-only one-click sign-in as a demo customer, shown on the portal login page when
 * `devSkipMfa()` holds (DEV_SKIP_MFA=1 with APP_ENV=local or preview, never staging or production).
 * The server action checks the same switch again, so the form is useless anywhere else.
 */
import { redirect } from "next/navigation";
import { persons, users } from "@beam/db/schema";
import { createAuthSession, recordSuccessfulLogin, safeReturnTo, setSessionCookie } from "@/lib/auth";
import { devSkipMfa } from "@/lib/auth-config";
import { ilike } from "drizzle-orm";
import { and, asc, eq, getAppDb, isNotNull } from "@/lib/ctx";

async function signInAsDemo(form: FormData): Promise<void> {
  "use server";
  if (!devSkipMfa()) return;
  const db = await getAppDb();
  const userId = (form.get("userId") as string | null) ?? "";
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.audience, "customer"), eq(users.status, "active")));
  if (!user) return;
  const now = new Date();
  const { token, expires } = await createAuthSession(db, { userId: user.id, audience: "customer", roleKey: null, now });
  await recordSuccessfulLogin(db, user.id, now);
  await setSessionCookie(token, expires);
  redirect(safeReturnTo((form.get("next") as string | null) ?? "", "/") as never);
}

export async function DevDemoLogin({ next }: { next: string }) {
  if (!devSkipMfa()) return null;
  const db = await getAppDb();
  const rows = await db
    .select({ id: users.id, email: users.email, first: persons.firstName, last: persons.lastName })
    .from(users)
    .innerJoin(persons, eq(persons.id, users.personId))
    .where(and(eq(users.audience, "customer"), eq(users.status, "active")))
    .orderBy(asc(users.email))
    .limit(12);
  if (!rows.length) return null;
  return (
    <section className="grid gap-3 rounded-xl border border-dashed border-amber-500/60 bg-amber-50/60 p-4 text-sm">
      <p className="font-semibold">Demo-login</p>
      <div className="grid gap-2">
        {rows.map((r) => (
          <form key={r.id} action={signInAsDemo}>
            <input type="hidden" name="userId" value={r.id} />
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-left hover:bg-muted">
              <span className="font-medium">{[r.first, r.last].filter(Boolean).join(" ") || r.email}</span>
              <span className="text-muted-foreground">{r.email}</span>
            </button>
          </form>
        ))}
      </div>
    </section>
  );
}

/** The demo roles in the owner's words (roles builder: owner = Administrator, reception = Front Desk, ...). */
const DEMO_ROLE_LABELS: Record<string, string> = {
  owner: "Administrator",
  management: "Manager",
  reception: "Front Desk",
  finance: "Finance",
  customer_service: "Klantendienst",
  sales: "Sales",
  marketing: "Marketing",
  technical_admin: "Technisch beheer",
  external_partner: "Externe partner",
};

/** Signs in as a demo staff user, MFA-complete, under the same switch (never staging or production). */
async function signInAsDemoStaff(form: FormData): Promise<void> {
  "use server";
  if (!devSkipMfa()) return;
  const db = await getAppDb();
  const userId = (form.get("userId") as string | null) ?? "";
  const [user] = await db
    .select({ id: users.id, roleKey: users.roleKey })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.audience, "staff"), eq(users.status, "active"), isNotNull(users.mfaEnrolledAt), ilike(users.email, "%@demo.beam.be")));
  if (!user) return;
  const now = new Date();
  const { token, expires } = await createAuthSession(db, { userId: user.id, audience: "staff", roleKey: user.roleKey, now, mfaAt: now });
  await recordSuccessfulLogin(db, user.id, now);
  await setSessionCookie(token, expires);
  redirect(safeReturnTo((form.get("next") as string | null) ?? "", "/admin") as never);
}

/**
 * Demo and local only: one-click sign-in as each demo staff user (owner first), shown on
 * `/admin/login` when `devSkipMfa()` holds, so the team can work in the back-office without the
 * password and authenticator steps. The server action checks the same switch again.
 */
export async function DevStaffLogin({ next }: { next: string }) {
  if (!devSkipMfa()) return null;
  const db = await getAppDb();
  const rows = await db
    .select({ id: users.id, email: users.email, roleKey: users.roleKey })
    .from(users)
    .where(and(eq(users.audience, "staff"), eq(users.status, "active"), isNotNull(users.mfaEnrolledAt), ilike(users.email, "%@demo.beam.be")))
    .orderBy(asc(users.email))
    .limit(20);
  if (!rows.length) return null;
  rows.sort((a, b) => Number(b.roleKey === "owner") - Number(a.roleKey === "owner"));
  return (
    <section className="grid gap-3 rounded-xl border border-dashed border-amber-500/60 bg-amber-50/60 p-4 text-sm" data-testid="dev-staff-login">
      <p className="font-semibold">Demo: direct inloggen</p>
      <div className="grid gap-2">
        {rows.map((r) => (
          <form key={r.id} action={signInAsDemoStaff}>
            <input type="hidden" name="userId" value={r.id} />
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left hover:bg-muted">
              <span className="font-medium">{DEMO_ROLE_LABELS[r.roleKey ?? ""] ?? r.roleKey}</span>
              <span className="truncate text-muted-foreground">{r.email}</span>
            </button>
          </form>
        ))}
      </div>
    </section>
  );
}
