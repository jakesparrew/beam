/**
 * Local-only one-click sign-in as a demo customer, shown on the portal login page when
 * `devSkipMfa()` holds (DEV_SKIP_MFA=1 with APP_ENV=local, never on Vercel or in production).
 * The server action checks the same switch again, so the form is useless anywhere else.
 */
import { redirect } from "next/navigation";
import { persons, users } from "@beam/db/schema";
import { createAuthSession, recordSuccessfulLogin, safeReturnTo, setSessionCookie } from "@/lib/auth";
import { devSkipMfa } from "@/lib/auth-config";
import { and, asc, eq, getAppDb } from "@/lib/ctx";

async function signInAsDemo(form: FormData): Promise<void> {
  "use server";
  if (!devSkipMfa()) return;
  const db = await getAppDb();
  const userId = String(form.get("userId") ?? "");
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.audience, "customer"), eq(users.status, "active")));
  if (!user) return;
  const now = new Date();
  const { token, expires } = await createAuthSession(db, { userId: user.id, audience: "customer", roleKey: null, now });
  await recordSuccessfulLogin(db, user.id, now);
  await setSessionCookie(token, expires);
  redirect(safeReturnTo(String(form.get("next") ?? ""), "/") as never);
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
      <p className="font-semibold">Demo-login (alleen lokaal)</p>
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
