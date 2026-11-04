"use client";
/**
 * Presenters of a webinar (webinar spec 5.1, principle 1): a staff member or an external
 * presenter by email (a crm person, no consent written), the public display name and the role
 * (host, presenter, moderator). Add, change the role or name, remove. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, FormField, Input } from "@beam/ui";
import { removePresenter, upsertPresenter } from "../../actions";
import { Message, failureText, formText, selectClass } from "./webinar-form";

type Role = "host" | "presenter" | "moderator";
const ROLES: readonly Role[] = ["host", "presenter", "moderator"];

export type PresenterItem = { id: string; displayName: string; role: Role; email: string | null; userId: string | null };

export type PresenterListLabels = {
  title: string;
  empty: string;
  kind: string;
  kindUser: string;
  kindEmail: string;
  user: string;
  email: string;
  displayName: string;
  role: string;
  roles: Record<Role, string>;
  add: string;
  remove: string;
  saved: string;
  errors: Record<string, string>;
};

export function PresenterList({
  webinarId,
  presenters,
  staff,
  editable,
  labels,
}: {
  webinarId: string;
  presenters: PresenterItem[];
  staff: Array<{ id: string; label: string }>;
  editable: boolean;
  labels: PresenterListLabels;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<"user" | "email">("user");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function act(call: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>) {
    setPending(true);
    setMessage(null);
    try {
      const res = await call();
      if (res.ok) {
        setMessage({ error: false, text: labels.saved });
        router.refresh();
        return true;
      }
      setMessage({ error: true, text: failureText(labels.errors, res.error) });
      return false;
    } finally {
      setPending(false);
    }
  }

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    const identity = kind === "user" ? { userId: formText(f, "userId") } : { email: formText(f, "email") };
    const ok = await act(() => upsertPresenter({ webinarId, ...identity, displayName: formText(f, "displayName"), role: formText(f, "role") }));
    if (ok) form.reset();
  }

  return (
    <section aria-labelledby="presenters-title" className="grid gap-3 rounded-md border p-4">
      <h2 id="presenters-title" className="text-lg font-semibold">
        {labels.title}
      </h2>
      <Message message={message} />
      {presenters.length === 0 ? <p className="text-sm text-muted-foreground">{labels.empty}</p> : null}
      <ul className="grid gap-2">
        {presenters.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{p.displayName}</span>
            {p.email ? <span className="text-muted-foreground">{p.email}</span> : null}
            {editable ? (
              <>
                <label className="sr-only" htmlFor={`role-${p.id}`}>
                  {labels.role}
                </label>
                <select
                  id={`role-${p.id}`}
                  className={`${selectClass} w-auto`}
                  defaultValue={p.role}
                  disabled={pending}
                  onChange={(e) =>
                    void act(() =>
                      upsertPresenter({ webinarId, presenterId: p.id, ...(p.userId ? { userId: p.userId } : { email: p.email ?? "" }), displayName: p.displayName, role: e.target.value }),
                    )
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {labels.roles[r]}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void act(() => removePresenter({ presenterId: p.id }))}>
                  {labels.remove}
                </Button>
              </>
            ) : (
              <span>{labels.roles[p.role]}</span>
            )}
          </li>
        ))}
      </ul>
      {editable ? (
        <form onSubmit={(e) => void onAdd(e)} className="grid gap-3 sm:grid-cols-2">
          <fieldset className="grid gap-1 sm:col-span-2">
            <legend className="text-sm font-medium">{labels.kind}</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="kind" checked={kind === "user"} onChange={() => setKind("user")} />
                {labels.kindUser}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="kind" checked={kind === "email"} onChange={() => setKind("email")} />
                {labels.kindEmail}
              </label>
            </div>
          </fieldset>
          {kind === "user" ? (
            <FormField label={labels.user} required>
              <select name="userId" className={selectClass} required>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </FormField>
          ) : (
            <FormField label={labels.email} required>
              <Input name="email" type="email" maxLength={254} required />
            </FormField>
          )}
          <FormField label={labels.displayName} required>
            <Input name="displayName" maxLength={120} required />
          </FormField>
          <FormField label={labels.role}>
            <select name="role" className={selectClass} defaultValue="presenter">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {labels.roles[r]}
                </option>
              ))}
            </select>
          </FormField>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {labels.add}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
