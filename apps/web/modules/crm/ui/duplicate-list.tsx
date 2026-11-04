"use client";
/**
 * The duplicate review queue (crm spec 5.1, `/admin/persons/duplicates`): open candidate pairs by
 * score, both persons side by side with their reasons and created dates, "Merge" (opens the
 * compare screen with the older person as the one that stays) and "Not a duplicate". Every
 * string is a prop.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardContent, EmptyState } from "@beam/ui";
import { dismissDuplicate } from "../duplicates/actions";

export type DuplicateListPerson = { id: string; customerNumber: string; name: string; email: string | null; created: string };

export type DuplicateListItem = {
  id: string;
  score: number;
  reasons: string[];
  /** The person that stays by default (the older one). */
  keep: DuplicateListPerson;
  other: DuplicateListPerson;
};

export type DuplicateListLabels = {
  empty: string;
  /** Template with `{score}`. */
  score: string;
  reasons: string;
  /** Template with `{date}`. */
  created: string;
  merge: string;
  dismiss: string;
  dismissed: string;
  error: string;
};

function PersonCell({ person, created }: { person: DuplicateListPerson; created: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <Link href={`/admin/persons/${person.id}` as Route} className="truncate font-medium hover:underline">
        {person.name || person.customerNumber}
      </Link>
      <span className="text-xs text-muted-foreground">
        {person.customerNumber}
        {person.email ? ` · ${person.email}` : ""}
      </span>
      <span className="text-xs text-muted-foreground">{created}</span>
    </div>
  );
}

export function DuplicateList({ items, labels, canMerge }: { items: DuplicateListItem[]; labels: DuplicateListLabels; canMerge: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function dismiss(candidateId: string) {
    setBusy(candidateId);
    setMessage(null);
    const result = await dismissDuplicate({ candidateId });
    setBusy(null);
    setMessage(result.ok ? labels.dismissed : labels.error);
    if (result.ok) router.refresh();
  }

  if (!items.length) return <EmptyState title={labels.empty} />;
  return (
    <div className="grid gap-3">
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      {items.map((item) => (
        <Card key={item.id}>
          <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto] md:items-center">
            <PersonCell person={item.keep} created={labels.created.replace("{date}", item.keep.created)} />
            <PersonCell person={item.other} created={labels.created.replace("{date}", item.other.created)} />
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <Badge>{labels.score.replace("{score}", String(item.score))}</Badge>
              <span className="sr-only">{labels.reasons}</span>
              {item.reasons.map((r) => (
                <Badge key={r} variant="outline">
                  {r}
                </Badge>
              ))}
              {canMerge ? (
                <>
                  <Button asChild size="sm">
                    <Link href={`/admin/persons/${item.keep.id}/merge?with=${item.other.id}` as Route}>{labels.merge}</Link>
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => void dismiss(item.id)}>
                    {labels.dismiss}
                  </Button>
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
