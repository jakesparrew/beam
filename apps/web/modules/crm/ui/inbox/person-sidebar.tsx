"use client";
/**
 * The linked person beside a thread (crm spec 5.1): status, credits, membership and next booking
 * with a link to the profile; for an unlinked thread the person search (a GET form on the page)
 * with a "Link" button per result and "Create person from sender" (`linkThreadPerson`).
 * Inbound messages never create a person on their own (rule 3.49): only this staff action does.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input } from "@beam/ui";
import { linkThreadPerson } from "../../inbox/actions";

export type SidebarPerson = {
  id: string;
  name: string;
  email: string | null;
  facts: { label: string; value: string }[];
};

export type SidebarLabels = {
  title: string;
  open: string;
  unlinked: string;
  search: string;
  searchPlaceholder: string;
  searchButton: string;
  link: string;
  noResults: string;
  create: string;
  createLocale: string;
  error: string;
  locales: { value: "nl-BE" | "fr-BE" | "en"; label: string }[];
};

export function PersonSidebar({
  threadId,
  person,
  results,
  query,
  canWrite,
  labels,
}: {
  threadId: string;
  person: SidebarPerson | null;
  /** Person search results for an unlinked thread (`?q=` on the page). */
  results: { id: string; label: string }[];
  query: string;
  canWrite: boolean;
  labels: SidebarLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<"nl-BE" | "fr-BE" | "en">(labels.locales[0]?.value ?? "nl-BE");

  function link(input: { personId: string } | { createFromSender: { locale: "nl-BE" | "fr-BE" | "en" } }) {
    setError(null);
    startTransition(async () => {
      const result = await linkThreadPerson({ threadId, ...input });
      if (!result.ok) setError(labels.error);
      else router.refresh();
    });
  }

  return (
    <aside className="grid content-start gap-3 rounded-md border p-4" aria-busy={pending}>
      <h2 className="font-semibold">{labels.title}</h2>
      {person ? (
        <>
          <div className="grid gap-0.5">
            <span className="font-medium">{person.name}</span>
            {person.email ? <span className="text-sm text-muted-foreground">{person.email}</span> : null}
          </div>
          <dl className="grid gap-1 text-sm">
            {person.facts.map((f) => (
              <div key={f.label} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="text-right">{f.value}</dd>
              </div>
            ))}
          </dl>
          <Link href={`/admin/persons/${person.id}`} className="text-sm font-medium underline underline-offset-4">
            {labels.open}
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{labels.unlinked}</p>
          {canWrite ? (
            <>
              <form method="get" className="flex gap-2" role="search">
                <Input name="q" defaultValue={query} placeholder={labels.searchPlaceholder} aria-label={labels.search} />
                <Button type="submit" variant="outline">
                  {labels.searchButton}
                </Button>
              </form>
              {query ? (
                results.length ? (
                  <ul className="grid gap-1">
                    {results.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{r.label}</span>
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => link({ personId: r.id })}>
                          {labels.link}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{labels.noResults}</p>
                )
              ) : null}
              <div className="grid gap-2 border-t pt-3">
                <label className="flex items-center gap-2 text-sm">
                  <span>{labels.createLocale}</span>
                  <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as "nl-BE" | "fr-BE" | "en")}
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {labels.locales.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="outline" disabled={pending} onClick={() => link({ createFromSender: { locale } })}>
                  {labels.create}
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </aside>
  );
}
