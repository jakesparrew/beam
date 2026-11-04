"use client";
/**
 * The segment builder of `/admin/segments/new` and `/admin/segments/[id]` (crm spec 5.1): name,
 * description, kind, the rule tree (dynamic), the exclusions picker, a live count with a
 * 20-person sample (debounced 500 ms), save and refresh now; for static segments the member
 * list with add by search or by a CSV of customer numbers. Every string is a prop.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { EMPTY_SEGMENT_RULE, type SegmentRule } from "@beam/core/crm";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Textarea } from "@beam/ui";
import { archiveSegment, findSegmentPersons, previewSegmentRule, refreshSegmentNow, saveSegment, setStaticMembers } from "../../segments/actions";
import { plural, selectClass, type Option, type SegmentBuilderLabels } from "./field-picker";
import { GroupEditor } from "./rule-row";

export type { Option, SegmentBuilderLabels } from "./field-picker";

export type SegmentPerson = { id: string; customerNumber: string; name: string };

export type SegmentDraft = {
  id?: string;
  name: string;
  description: string;
  kind: "dynamic" | "static";
  definition: SegmentRule;
  excludeSegmentIds: string[];
};

type Group = Extract<SegmentRule, { op: "and" | "or" }>;
const asGroup = (rule: SegmentRule): Group => ("op" in rule ? rule : { op: "and", rules: [rule] });

type Preview = { count: number; sample: SegmentPerson[]; sql?: string } | { error: string } | null;

export function SegmentBuilder({
  initial,
  segments,
  canEdit,
  labels,
}: {
  initial: SegmentDraft;
  /** Other non-archived segments (exclusions and `in_segment` targets). */
  segments: Option[];
  canEdit: boolean;
  labels: SegmentBuilderLabels;
}) {
  const router = useRouter();
  const b = labels.builder;
  const [draft, setDraft] = useState<SegmentDraft>({ ...initial, definition: asGroup(initial.definition ?? EMPTY_SEGMENT_RULE) });
  const [preview, setPreview] = useState<Preview>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (draft.kind !== "dynamic") return;
    const mine = ++seq.current;
    const timer = setTimeout(() => void (async () => {
      const res = await previewSegmentRule({ definition: draft.definition, excludeIds: draft.excludeSegmentIds });
      if (mine !== seq.current) return;
      setPreview(res.ok ? res.data : { error: Object.values(res.error.fields ?? {})[0] ?? labels.common.error });
    })(), 500);
    return () => clearTimeout(timer);
  }, [draft.definition, draft.excludeSegmentIds, draft.kind, labels.common.error]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await saveSegment({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      ...(draft.description.trim() ? { description: draft.description } : {}),
      kind: draft.kind,
      definition: draft.kind === "dynamic" ? draft.definition : EMPTY_SEGMENT_RULE,
      excludeSegmentIds: draft.excludeSegmentIds,
    });
    setSaving(false);
    if (!res.ok) {
      const msg = res.error.message;
      setError(msg === "segment_cycle" ? b.cycle! : (Object.values(res.error.fields ?? {})[0] ?? labels.common.error));
      return;
    }
    if (!draft.id) router.push(`/admin/segments/${res.data.id}`);
    else router.refresh();
  };

  const others = segments.filter((s) => s.value !== draft.id);
  const toggleExclusion = (id: string, on: boolean) =>
    setDraft((d) => ({ ...d, excludeSegmentIds: on ? [...new Set([...d.excludeSegmentIds, id])] : d.excludeSegmentIds.filter((x) => x !== id) }));

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-6">
      <Card>
        <CardContent className="grid gap-4 pt-6 md:grid-cols-2">
          <FormField label={b.name}>
            <Input id="segment-name" required maxLength={200} disabled={!canEdit} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </FormField>
          <FormField label={b.kind}>
            <select id="segment-kind" className={selectClass} disabled={!canEdit} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as SegmentDraft["kind"] })}>
              {labels.kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </FormField>
          <div className="md:col-span-2">
            <FormField label={b.description}>
              <Textarea id="segment-description" maxLength={1000} disabled={!canEdit} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </FormField>
          </div>
        </CardContent>
      </Card>

      {draft.kind === "dynamic" ? (
        <Card>
          <CardHeader>
            <CardTitle>{b.rules}</CardTitle>
          </CardHeader>
          <CardContent>
            <GroupEditor group={asGroup(draft.definition)} onChange={(g) => setDraft((d) => ({ ...d, definition: g }))} depth={1} labels={labels} segments={others} path="rules" />
          </CardContent>
        </Card>
      ) : null}

      {others.length ? (
        <Card>
          <CardHeader>
            <CardTitle>{b.exclusions}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-x-4 gap-y-2">
            {others.map((s) => (
              <label key={s.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={!canEdit} checked={draft.excludeSegmentIds.includes(s.value)} onChange={(e) => toggleExclusion(s.value, e.target.checked)} />
                {s.label}
              </label>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {draft.kind === "dynamic" ? <PreviewPanel preview={preview} labels={labels} /> : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {canEdit ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? labels.common.saving : labels.common.save}
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/segments">{labels.common.cancel}</Link>
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function PreviewPanel({ preview, labels }: { preview: Preview; labels: SegmentBuilderLabels }) {
  const b = labels.builder;
  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle>{preview && "count" in preview ? plural(labels.plural.count, preview.count) : b.sample}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!preview ? <p className="text-sm text-muted-foreground">{labels.common.loading}</p> : null}
        {preview && "error" in preview ? <p className="text-sm text-destructive">{preview.error}</p> : null}
        {preview && "count" in preview ? (
          preview.sample.length ? (
            <ul className="grid gap-1 text-sm">
              {preview.sample.map((p) => (
                <li key={p.id}>
                  <Link className="underline-offset-2 hover:underline" href={`/admin/persons/${p.id}`}>
                    {p.customerNumber} · {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{b.sample_empty}</p>
          )
        ) : null}
        {preview && "sql" in preview && preview.sql ? (
          <details>
            <summary className="cursor-pointer text-sm">{b.sql}</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{preview.sql}</pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** "Refresh now" on the segment page (enqueues `segments.refresh_one` with reason `manual`). */
export function RefreshNowButton({ segmentId, labels }: { segmentId: string; labels: { refresh: string; queued: string; error: string } }) {
  const [state, setState] = useState<"idle" | "busy" | "queued" | "error">("idle");
  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={state === "busy"}
        onClick={() => void (async () => {
          setState("busy");
          const res = await refreshSegmentNow({ segmentId });
          setState(res.ok ? "queued" : "error");
        })()}
      >
        {labels.refresh}
      </Button>
      {state === "queued" ? <span className="text-sm text-muted-foreground">{labels.queued}</span> : null}
      {state === "error" ? <span className="text-sm text-destructive">{labels.error}</span> : null}
    </span>
  );
}

/** "Archive" on the segment list; the server refuses a segment that is still in use. */
export function ArchiveSegmentButton({ segmentId, labels }: { segmentId: string; labels: { archive: string; inUse: string; error: string } }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void (async () => {
          const res = await archiveSegment({ id: segmentId });
          if (res.ok) router.refresh();
          else setMessage(res.error.message === "segment_in_use" ? labels.inUse : labels.error);
        })()}
      >
        {labels.archive}
      </Button>
      {message ? <span className="text-sm text-destructive">{message}</span> : null}
    </span>
  );
}

export type StaticMembersLabels = {
  title: string;
  add: string;
  addCsv: string;
  remove: string;
  search: string;
  empty: string;
  error: string;
  unknown: string;
  count: { one: string; other: string };
};

/** The member list of a static segment, with add by search and by a CSV of customer numbers. */
export function StaticMembers({ segmentId, members, total, canEdit, labels }: { segmentId: string; members: SegmentPerson[]; total: number; canEdit: boolean; labels: StaticMembersLabels }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SegmentPerson[]>([]);
  const [csv, setCsv] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const change = async (add: string[], remove: string[]) => {
    const res = await setStaticMembers({ segmentId, add, remove });
    if (!res.ok) return setMessage(labels.error);
    setMessage(null);
    router.refresh();
  };
  const search = async () => {
    const res = await findSegmentPersons({ q });
    setFound(res.ok ? res.data.persons : []);
  };
  const addCsv = async () => {
    const numbers = csv.split(/[\s,;]+/).filter(Boolean);
    const res = await findSegmentPersons({ customerNumbers: numbers });
    if (!res.ok) return setMessage(labels.error);
    if (res.data.ids.length) await change(res.data.ids, []);
    setMessage(res.data.unknown.length ? `${labels.unknown}: ${res.data.unknown.join(", ")}` : null);
    setCsv("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {labels.title} · {plural(labels.count, total)}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {canEdit ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <div className="flex gap-2">
                <Input aria-label={labels.search} placeholder={labels.search} value={q} onChange={(e) => setQ(e.target.value)} />
                <Button type="button" variant="outline" onClick={() => void search()} disabled={!q.trim()}>
                  {labels.search}
                </Button>
              </div>
              {found.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {p.customerNumber} · {p.name}
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => void change([p.id], [])}>
                    {labels.add}
                  </Button>
                </div>
              ))}
            </div>
            <div className="grid gap-2">
              <Textarea aria-label={labels.addCsv} placeholder="C-000123, C-000124" value={csv} onChange={(e) => setCsv(e.target.value)} />
              <Button type="button" variant="outline" onClick={() => void addCsv()} disabled={!csv.trim()}>
                {labels.addCsv}
              </Button>
            </div>
          </div>
        ) : null}
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
        {members.length ? (
          <ul className="grid gap-1 text-sm">
            {members.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <Link className="underline-offset-2 hover:underline" href={`/admin/persons/${p.id}`}>
                  {p.customerNumber} · {p.name}
                </Link>
                {canEdit ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => void change([], [p.id])}>
                    {labels.remove}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        )}
      </CardContent>
    </Card>
  );
}
