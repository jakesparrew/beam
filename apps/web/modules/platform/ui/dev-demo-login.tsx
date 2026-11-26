/**
 * Demo and local only: one-click sign-in as a demo customer (portal login) or a demo staff user
 * (back-office login), shown when `devSkipMfa()` holds (DEV_SKIP_MFA=1 with APP_ENV=local or
 * preview, never staging or production). Every server action checks the same switch again.
 *
 * On the hosted demo the buttons sit behind a shared demo access code (`DEMO_ACCESS_CODE`):
 * whoever finds the demo link sees only a code field, so nobody outside the team can act as an
 * administrator (AI spend, deleting data, changing settings). A correct code leaves a 30-day
 * httpOnly cookie holding a hash of the code (never the code itself). Without `DEMO_ACCESS_CODE`
 * the hosted demo shows nothing (fail closed). Locally (APP_ENV=local) no code is asked.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ilike } from "drizzle-orm";
import { persons, users } from "@beam/db/schema";
import { createAuthSession, recordSuccessfulLogin, safeReturnTo, setSessionCookie } from "@/lib/auth";
import { devSkipMfa } from "@/lib/auth-config";
import { and, asc, eq, getAppDb, isNotNull } from "@/lib/ctx";

const DEMO_ACCESS_COOKIE = "beam_demo_access";
const DEMO_ACCESS_DAYS = 30;

const isLocal = () => process.env.APP_ENV === "local";
const demoCode = () => process.env.DEMO_ACCESS_CODE?.trim() || null;
const digest = (value: string) => createHash("sha256").update(`beam-demo-access:${value}`).digest();

function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the one-click buttons may show and act: locally always, on the demo after the code. */
async function hasDemoAccess(): Promise<boolean> {
  if (!devSkipMfa()) return false;
  if (isLocal()) return true;
  const code = demoCode();
  if (!code) return false;
  const stored = (await cookies()).get(DEMO_ACCESS_COOKIE)?.value ?? "";
  if (!/^[0-9a-f]{64}$/.test(stored)) return false;
  return sameDigest(Buffer.from(stored, "hex"), digest(code));
}

/** Checks the typed demo code and remembers the browser for 30 days. */
async function unlockDemo(form: FormData): Promise<void> {
  "use server";
  const next = safeReturnTo((form.get("next") as string | null) ?? "", "/");
  const code = demoCode();
  if (!devSkipMfa() || !code) redirect(next as never);
  const raw = form.get("code");
  const typed = typeof raw === "string" ? raw.trim() : "";
  if (sameDigest(digest(typed), digest(code))) {
    (await cookies()).set(DEMO_ACCESS_COOKIE, digest(code).toString("hex"), {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: DEMO_ACCESS_DAYS * 24 * 60 * 60,
    });
    redirect(next as never);
  }
  redirect(`${next}${next.includes("?") ? "&" : "?"}demo=wrong` as never);
}

/** The code field shown on the hosted demo until the browser holds a valid demo cookie. */
function DemoCodeForm({ next, wrong }: { next: string; wrong: boolean }) {
  return (
    <section className="grid gap-3 rounded-xl border border-dashed border-amber-500/60 bg-amber-50/60 p-4 text-sm" data-testid="dev-demo-code">
      <p className="font-semibold">Demo: direct inloggen</p>
      <form action={unlockDemo} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="next" value={next} />
        <label className="grid flex-1 gap-1">
          <span className="text-muted-foreground">Democode van het team</span>
          <input name="code" type="password" autoComplete="off" required className="h-10 rounded-lg border border-border bg-background px-3" />
        </label>
        <button type="submit" className="h-10 rounded-lg border border-border bg-background px-4 font-medium hover:bg-muted">
          Ontgrendelen
        </button>
      </form>
      {wrong ? <p className="text-destructive">Die code klopt niet.</p> : null}
    </section>
  );
}

async function signInAsDemo(form: FormData): Promise<void> {
  "use server";
  if (!(await hasDemoAccess())) return;
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

export async function DevDemoLogin({ next, wrongCode = false }: { next: string; wrongCode?: boolean }) {
  if (!devSkipMfa()) return null;
  if (!(await hasDemoAccess())) return demoCode() ? <DemoCodeForm next={next} wrong={wrongCode} /> : null;
  const db = await getAppDb();
  const rows = await db
    .select({ id: users.id, email: users.email, first: persons.firstName, last: persons.lastName })
    .from(users)
    .innerJoin(persons, eq(persons.id, users.personId))
    .where(and(eq(users.audience, "customer"), eq(users.status, "active"), ilike(users.email, "%@example.com")))
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

/** Signs in as a demo staff user, MFA-complete, after the demo access check (never staging or production). */
async function signInAsDemoStaff(form: FormData): Promise<void> {
  "use server";
  if (!(await hasDemoAccess())) return;
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
 * One-click sign-in as each demo staff user (owner first) on `/admin/login`, so the team works
 * in the back-office without the password and authenticator steps; behind the demo code on the
 * hosted demo.
 */
export async function DevStaffLogin({ next, wrongCode = false }: { next: string; wrongCode?: boolean }) {
  if (!devSkipMfa()) return null;
  if (!(await hasDemoAccess())) return demoCode() ? <DemoCodeForm next={`/admin/login?returnTo=${encodeURIComponent(next)}`} wrong={wrongCode} /> : null;
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
