"use client";
/**
 * The 360 sensitive panel (crm spec 5.1, rules 3.24 to 3.26), rendered only for holders of
 * `persons.sensitive_read`. Values stay hidden until "Reveal", which calls `revealSensitive` for
 * the keys the person has (one `sensitive.read` audit row); staff can set or clear a value.
 * Revealed values live only in this component's state. Every string is a prop.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Textarea } from "@beam/ui";
import type { SensitiveFieldKey } from "@beam/core/privacy";
import { revealSensitive, setSensitiveField } from "../sensitive/actions";

export type SensitivePanelView = {
  personId: string;
  present: Array<{ key: SensitiveFieldKey; label: string; updated: string }>;
  options: Array<{ key: SensitiveFieldKey; label: string }>;
};

export type SensitivePanelLabels = {
  title: string;
  hidden: string;
  reveal: string;
  empty: string;
  value: string;
  key: string;
  save: string;
  clear: string;
  edit: string;
  cancel: string;
  error: string;
};

export function SensitivePanel({ view, labels }: { view: SensitivePanelView; labels: SensitivePanelLabels }) {
  const router = useRouter();
  const [values, setValues] = useState<Partial<Record<SensitiveFieldKey, string>> | null>(null);
  const [editing, setEditing] = useState<SensitiveFieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    if (!view.present.length) return;
    setBusy(true);
    setError(null);
    const result = await revealSensitive({ personId: view.personId, keys: view.present.map((p) => p.key) });
    setBusy(false);
    if (result.ok) setValues(result.data.fields);
    else setError(labels.error);
  }

  async function save(key: SensitiveFieldKey, value: string | null) {
    setBusy(true);
    setError(null);
    const result = await setSensitiveField({ personId: view.personId, key, value });
    setBusy(false);
    if (!result.ok) {
      setError(labels.error);
      return;
    }
    setEditing(null);
    setDraft("");
    setValues(null);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{labels.title}</CardTitle>
        {view.present.length && !values ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reveal()}>
            {labels.reveal}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {view.present.length ? (
          <ul className="grid gap-2">
            {view.present.map((p) => (
              <li key={p.key} className="grid gap-1 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{p.label}</span>
                  <span className="text-xs text-muted-foreground">{p.updated}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{values ? (values[p.key] ?? "") : labels.hidden}</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(p.key);
                      setDraft(values?.[p.key] ?? "");
                    }}
                  >
                    {labels.edit}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(p.key, null)}>
                    {labels.clear}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        )}

        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing && draft.trim()) void save(editing, draft);
          }}
        >
          <Label htmlFor="sensitive-key">{labels.key}</Label>
          <select
            id="sensitive-key"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={editing ?? ""}
            onChange={(e) => setEditing((e.target.value || null) as SensitiveFieldKey | null)}
          >
            <option value="">—</option>
            {view.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <Label htmlFor="sensitive-value">{labels.value}</Label>
          <Textarea id="sensitive-value" value={draft} maxLength={5000} autoComplete="off" onChange={(e) => setDraft(e.target.value)} disabled={!editing || busy} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!editing || !draft.trim() || busy}>
              {labels.save}
            </Button>
            {editing ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(null);
                  setDraft("");
                }}
              >
                {labels.cancel}
              </Button>
            ) : null}
          </div>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
