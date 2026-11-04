"use client";
/**
 * The contacts of a company (crm spec 5.1): position, decision role, primary flag and the link
 * to each person's 360; ended contacts stay listed as history ("Until …"). With `crm.b2b`: link
 * an existing or a new person, and mark a contact as having left the company.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, Checkbox, EmptyState, FormField, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { endContact, findContactCandidates, linkContact, updateContact } from "../companies/actions";

export type ContactView = {
  id: string;
  personId: string;
  name: string;
  position: string | null;
  decisionRole: string | null;
  isPrimary: boolean;
  /** Formatted end date, or null for a current contact. */
  endedLabel: string | null;
};

export type ContactListLabels = {
  empty: string;
  name: string;
  position: string;
  decisionRole: string;
  relationship: string;
  isPrimary: string;
  primary: string;
  endedOn: string;
  endContact: string;
  makePrimary: string;
  linkContact: string;
  linkExisting: string;
  linkNew: string;
  search: string;
  searchPlaceholder: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  emailTaken: string;
  contactExists: string;
  none: string;
  save: string;
  saving: string;
  cancel: string;
  open: string;
  error: string;
  decisionRoles: Record<string, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type Candidate = { id: string; customerNumber: string; name: string };

function LinkContactForm({ companyId, locale, labels, onDone }: { companyId: string; locale: string; labels: ContactListLabels; onDone: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [isPrimary, setIsPrimary] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (q.trim().length < 2) return;
    const result = await findContactCandidates({ q });
    setCandidates(result.ok ? result.data : []);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const opt = (k: string) => (get(k) ? get(k) : undefined);
    if (mode === "existing" && !picked) return;
    setPending(true);
    setError(null);
    try {
      const result = await linkContact({
        companyId,
        ...(mode === "existing" && picked
          ? { personId: picked.id }
          : { newPerson: { email: opt("email"), phone: opt("phone"), firstName: opt("firstName"), lastName: opt("lastName"), locale, acquisition: { source: "manual" } } }),
        position: opt("position"),
        decisionRole: opt("decisionRole"),
        relationship: opt("relationship"),
        isPrimary,
      });
      if (result.ok) {
        onDone();
        router.refresh();
        return;
      }
      const m = result.error.message;
      setError(m === "email_taken" ? labels.emailTaken : m === "contact_exists" ? labels.contactExists : labels.error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2" role="radiogroup">
            <Button type="button" size="sm" variant={mode === "existing" ? "default" : "outline"} aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>
              {labels.linkExisting}
            </Button>
            <Button type="button" size="sm" variant={mode === "new" ? "default" : "outline"} aria-pressed={mode === "new"} onClick={() => setMode("new")}>
              {labels.linkNew}
            </Button>
          </div>
          {mode === "existing" ? (
            <div className="grid gap-2">
              <div className="flex gap-2">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={labels.searchPlaceholder} aria-label={labels.search} />
                <Button type="button" variant="outline" onClick={() => void search()}>
                  {labels.search}
                </Button>
              </div>
              {picked ? (
                <p className="text-sm">
                  <Badge variant="secondary">{picked.customerNumber}</Badge> {picked.name}
                </p>
              ) : (
                <ul className="grid gap-1">
                  {candidates.map((c) => (
                    <li key={c.id}>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(c)}>
                        {c.customerNumber} · {c.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={labels.firstName}>
                <Input name="firstName" maxLength={100} />
              </FormField>
              <FormField label={labels.lastName}>
                <Input name="lastName" maxLength={100} />
              </FormField>
              <FormField label={labels.email}>
                <Input name="email" type="email" maxLength={254} />
              </FormField>
              <FormField label={labels.phone}>
                <Input name="phone" type="tel" maxLength={40} />
              </FormField>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={labels.position}>
              <Input name="position" maxLength={200} />
            </FormField>
            <FormField label={labels.decisionRole}>
              <select name="decisionRole" defaultValue="" className={selectClass}>
                <option value="">{labels.none}</option>
                {Object.entries(labels.decisionRoles).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={labels.relationship}>
              <Input name="relationship" maxLength={200} />
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            {labels.isPrimary}
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || (mode === "existing" && !picked)}>
              {pending ? labels.saving : labels.save}
            </Button>
            <Button type="button" variant="outline" onClick={onDone}>
              {labels.cancel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function ContactList({
  companyId,
  contacts,
  canEdit,
  locale,
  today,
  labels,
}: {
  companyId: string;
  contacts: ContactView[];
  canEdit: boolean;
  locale: string;
  /** `YYYY-MM-DD` in Brussels: the end date of "Left the company". */
  today: string;
  labels: ContactListLabels;
}) {
  const router = useRouter();
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<{ ok: boolean }>) {
    setBusy(id);
    setError(null);
    try {
      const result = await fn();
      if (result.ok) router.refresh();
      else setError(labels.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4">
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setLinking(true)} disabled={linking}>
            {labels.linkContact}
          </Button>
        </div>
      ) : null}
      {linking ? <LinkContactForm companyId={companyId} locale={locale} labels={labels} onDone={() => setLinking(false)} /> : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {contacts.length === 0 ? (
        <EmptyState title={labels.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.name}</TableHead>
              <TableHead>{labels.position}</TableHead>
              <TableHead>{labels.decisionRole}</TableHead>
              <TableHead>{labels.endedOn}</TableHead>
              {canEdit ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {contacts.map((c) => (
              <TableRow key={c.id} className={c.endedLabel ? "text-muted-foreground" : undefined}>
                <TableCell>
                  <Link href={`/admin/persons/${c.personId}` as never} className="font-medium underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                  {c.isPrimary && !c.endedLabel ? <Badge className="ml-2">{labels.primary}</Badge> : null}
                </TableCell>
                <TableCell>{c.position ?? "—"}</TableCell>
                <TableCell>{c.decisionRole ? (labels.decisionRoles[c.decisionRole] ?? c.decisionRole) : "—"}</TableCell>
                <TableCell>{c.endedLabel ?? "—"}</TableCell>
                {canEdit ? (
                  <TableCell>
                    {c.endedLabel ? null : (
                      <div className="flex flex-wrap gap-1">
                        {!c.isPrimary ? (
                          <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void run(c.id, () => updateContact({ contactId: c.id, isPrimary: true }))}>
                            {labels.makePrimary}
                          </Button>
                        ) : null}
                        <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => void run(c.id, () => endContact({ contactId: c.id, endedOn: today }))}>
                          {labels.endContact}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
