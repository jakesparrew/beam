"use client";
/**
 * The custom dashboard editor (ops spec 5, rule 79): name, "share with the team", and the widget
 * list. Each widget picks a KPI from the catalogue the page passes (`KPI_REGISTRY`, labels
 * translated on the server), then only the periods, visualisations and (for segmentable KPIs)
 * segments that KPI supports. At most 24 widgets. Saves through `saveDashboard`; the owner or a
 * dashboard manager can delete through `deleteDashboard` after a confirmation.
 */
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, Input, Label } from "@beam/ui";
import type { DashboardDefinition } from "@beam/core/ops";
import { deleteDashboard, saveDashboard } from "../insights/actions";

type Widget = DashboardDefinition["widgets"][number];
type Viz = Widget["viz"];
type Period = Widget["period"];

export type PickerKpi = { key: string; label: string; group: string; groupLabel: string; periods: Period[]; views: Viz[]; segmentable: boolean };

export type WidgetPickerLabels = {
  create: string;
  edit: string;
  done: string;
  name: string;
  shared: string;
  addWidget: string;
  removeWidget: string;
  maxWidgets: string;
  save: string;
  saving: string;
  saved: string;
  delete: string;
  deleteConfirm: string;
  deleted: string;
  kpi: string;
  period: string;
  compare: string;
  segment: string;
  segmentNone: string;
  viz: string;
  errors: Record<"validation" | "forbidden" | "not_found" | "generic", string>;
};

const MAX = 24;
const SELECT = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

const newId = () => `w${Math.random().toString(36).slice(2, 10)}`;

export function WidgetPicker({
  mode,
  dashboardId,
  initial,
  catalogue,
  periods,
  vizLabels,
  segments,
  labels,
  canDelete = false,
}: {
  mode: "create" | "edit";
  dashboardId?: string;
  initial: { name: string; isShared: boolean; widgets: Widget[] };
  catalogue: PickerKpi[];
  periods: { value: Period; label: string }[];
  vizLabels: Record<Viz, string>;
  segments: { id: string; name: string }[];
  labels: WidgetPickerLabels;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial.name);
  const [isShared, setShared] = useState(initial.isShared);
  const [widgets, setWidgets] = useState<Widget[]>(initial.widgets);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const byKey = new Map(catalogue.map((k) => [k.key, k]));
  const groups = [...new Map(catalogue.map((k) => [k.group, k.groupLabel]))];

  /** Keeps a widget consistent with its KPI: a supported period, view, and segment only when allowed. */
  function fit(w: Widget): Widget {
    const k = byKey.get(w.kpi);
    if (!k) return w;
    const next: Widget = { ...w, period: k.periods.includes(w.period) ? w.period : k.periods[0]!, viz: k.views.includes(w.viz) ? w.viz : k.views[0]! };
    if (!k.segmentable || !next.segmentId) delete next.segmentId;
    return next;
  }
  const update = (id: string, patch: Partial<Widget>) => setWidgets((ws) => ws.map((w) => (w.id === id ? fit({ ...w, ...patch }) : w)));
  const add = () => {
    const first = catalogue[0];
    if (!first || widgets.length >= MAX) return;
    setWidgets((ws) => [...ws, fit({ id: newId(), kpi: first.key, period: "month", compare: true, viz: "number" })]);
  };

  async function save() {
    setBusy(true);
    setMessage(null);
    const res = await saveDashboard({ ...(dashboardId ? { id: dashboardId } : {}), name, isShared, definition: { widgets } });
    setBusy(false);
    if (!res.ok) {
      setMessage(labels.errors[res.error.code as keyof WidgetPickerLabels["errors"]] ?? labels.errors.generic);
      return;
    }
    setMessage(labels.saved);
    if (mode === "create") router.push(`/admin/dashboard/custom/${res.data.id}` as Route);
    else {
      setOpen(false);
      router.refresh();
    }
  }

  async function remove() {
    if (!dashboardId || !window.confirm(labels.deleteConfirm)) return;
    setBusy(true);
    const res = await deleteDashboard({ id: dashboardId });
    setBusy(false);
    if (!res.ok) {
      setMessage(labels.errors[res.error.code as keyof WidgetPickerLabels["errors"]] ?? labels.errors.generic);
      return;
    }
    router.push("/admin/dashboard/custom" as Route);
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setOpen(true)} data-testid={mode === "create" ? "dashboard-create" : "dashboard-edit"}>
          {mode === "create" ? labels.create : labels.edit}
        </Button>
        {canDelete && dashboardId ? (
          <Button type="button" variant="destructive" onClick={remove} disabled={busy} data-testid="dashboard-delete">
            {labels.delete}
          </Button>
        ) : null}
        {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
      </div>
    );
  }

  return (
    <form
      className="grid gap-4 rounded-lg border p-4"
      data-testid="widget-picker"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-2 sm:max-w-md">
        <Label htmlFor={`${formId}-name`}>{labels.name}</Label>
        <Input id={`${formId}-name`} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isShared} onChange={(e) => setShared(e.target.checked)} />
        {labels.shared}
      </label>

      <ol className="grid gap-3">
        {widgets.map((w, i) => {
          const k = byKey.get(w.kpi);
          const fid = `${formId}-${w.id}`;
          return (
            <li key={w.id} className="grid gap-3 rounded-md border p-3 md:grid-cols-6" data-testid={`picker-widget-${i}`}>
              <div className="grid gap-1 md:col-span-2">
                <Label htmlFor={`${fid}-kpi`}>{labels.kpi}</Label>
                <select id={`${fid}-kpi`} className={SELECT} value={w.kpi} onChange={(e) => update(w.id, { kpi: e.target.value })}>
                  {groups.map(([g, gl]) => (
                    <optgroup key={g} label={gl}>
                      {catalogue
                        .filter((c) => c.group === g)
                        .map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${fid}-period`}>{labels.period}</Label>
                <select id={`${fid}-period`} className={SELECT} value={w.period} onChange={(e) => update(w.id, { period: e.target.value as Period })}>
                  {periods
                    .filter((p) => !k || k.periods.includes(p.value))
                    .map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${fid}-viz`}>{labels.viz}</Label>
                <select id={`${fid}-viz`} className={SELECT} value={w.viz} onChange={(e) => update(w.id, { viz: e.target.value as Viz })}>
                  {(k?.views ?? (["number"] as Viz[])).map((v) => (
                    <option key={v} value={v}>
                      {vizLabels[v]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${fid}-segment`}>{labels.segment}</Label>
                <select
                  id={`${fid}-segment`}
                  className={SELECT}
                  value={w.segmentId ?? ""}
                  disabled={!k?.segmentable}
                  onChange={(e) => update(w.id, e.target.value ? { segmentId: e.target.value } : { segmentId: undefined })}
                >
                  <option value="">{labels.segmentNone}</option>
                  {segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={w.compare} onChange={(e) => update(w.id, { compare: e.target.checked })} />
                  {labels.compare}
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={() => setWidgets((ws) => ws.filter((x) => x.id !== w.id))}>
                  {labels.removeWidget}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={add} disabled={widgets.length >= MAX} data-testid="picker-add">
          {labels.addWidget}
        </Button>
        {widgets.length >= MAX ? <span className="text-sm text-muted-foreground">{labels.maxWidgets}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || name.trim() === ""} data-testid="picker-save">
          {busy ? labels.saving : labels.save}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {labels.done}
        </Button>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
