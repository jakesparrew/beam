"use client";
/**
 * Event rules of the segment builder (crm spec 4.6): an allowed `activity_events` kind, an
 * optional mode (live, replay, on demand), `where` filters on the kind's declared data keys
 * (a range on numeric keys), a window in days, a minimum count and "did not happen".
 */
import { SEGMENT_ALLOWED_EVENT_KINDS, SEGMENT_EVENT_DATA_KEYS, SEGMENT_NUMERIC_EVENT_KEYS, type AllowedEventKind, type EventWhereValue, type SegmentRule } from "@beam/core/crm";
import { Button, Input } from "@beam/ui";
import { plural, selectClass, type SegmentBuilderLabels } from "./field-picker";

export type EventRule = Extract<SegmentRule, { type: "event" }>;

const kindLabel = (labels: SegmentBuilderLabels, kind: string) => labels.eventKinds[kind.replace(".", "_")] ?? kind;

export function newEventRule(): EventRule {
  return { type: "event", kind: SEGMENT_ALLOWED_EVENT_KINDS[0]! };
}

export function EventRuleEditor({ rule, onChange, labels }: { rule: EventRule; onChange: (rule: EventRule) => void; labels: SegmentBuilderLabels }) {
  const b = labels.builder;
  const keys: readonly string[] = SEGMENT_EVENT_DATA_KEYS[rule.kind] ?? [];
  const where = Object.entries(rule.where ?? {}).filter((e): e is [string, EventWhereValue] => e[1] !== undefined);
  const unusedKeys = keys.filter((k) => !(k in (rule.where ?? {})));
  const set = (patch: Partial<EventRule>) => {
    const next: EventRule = { ...rule, ...patch };
    for (const k of Object.keys(next) as (keyof EventRule)[]) if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  const setWhere = (entries: Array<[string, EventWhereValue]>) => set({ where: entries.length ? Object.fromEntries(entries) : undefined });

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rule.negate === true} onChange={(e) => set({ negate: e.target.checked || undefined })} />
          {b.event_negate}
        </label>
        <select aria-label={b.event_kind} className={selectClass} value={rule.kind} onChange={(e) => onChange({ type: "event", kind: e.target.value as AllowedEventKind, ...(rule.negate ? { negate: true } : {}) })}>
          {SEGMENT_ALLOWED_EVENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(labels, k)}
            </option>
          ))}
        </select>
        <select aria-label={b.event_mode} className={selectClass} value={rule.mode ?? ""} onChange={(e) => set({ mode: (e.target.value || undefined) as EventRule["mode"] })}>
          <option value="">{b.event_any_mode}</option>
          {labels.modes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          {b.days}
          <Input
            type="number"
            min={1}
            max={3650}
            className="w-24"
            value={rule.withinDays ?? ""}
            placeholder="—"
            onChange={(e) => set({ withinDays: e.target.value ? Math.trunc(Number(e.target.value)) : undefined })}
          />
          {rule.withinDays ? <span className="text-muted-foreground">{plural(labels.plural.withinDays, rule.withinDays)}</span> : null}
        </label>
        <label className="flex items-center gap-2">
          <Input type="number" min={1} max={1000} className="w-20" value={rule.minCount ?? 1} onChange={(e) => set({ minCount: Number(e.target.value) > 1 ? Math.trunc(Number(e.target.value)) : undefined })} />
          <span className="text-muted-foreground">{plural(labels.plural.minCount, rule.minCount ?? 1)}</span>
        </label>
      </div>
      {keys.length ? (
        <div className="grid gap-2">
          <span className="text-sm font-medium">{b.event_where}</span>
          {where.map(([key, value], i) => (
            <WhereRow
              key={key}
              keyName={key}
              value={value}
              labels={labels}
              onChange={(v) => setWhere(where.map((e, j) => (j === i ? [key, v] : e)))}
              onRemove={() => setWhere(where.filter((_, j) => j !== i))}
            />
          ))}
          {unusedKeys.length ? (
            <select
              aria-label={b.event_where}
              className={selectClass}
              value=""
              onChange={(e) => {
                const k = e.target.value;
                if (k) setWhere([...where, [k, SEGMENT_NUMERIC_EVENT_KEYS.includes(k) ? { gte: 0 } : k.startsWith("is_") ? true : ""]]);
              }}
            >
              <option value="">+ {b.event_where}</option>
              {unusedKeys.map((k) => (
                <option key={k} value={k}>
                  {labels.dataKeys[k] ?? k}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function WhereRow({ keyName, value, labels, onChange, onRemove }: { keyName: string; value: EventWhereValue; labels: SegmentBuilderLabels; onChange: (v: EventWhereValue) => void; onRemove: () => void }) {
  const b = labels.builder;
  const numeric = SEGMENT_NUMERIC_EVENT_KEYS.includes(keyName);
  const range = typeof value === "object" && value !== null ? value : {};
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-32">{labels.dataKeys[keyName] ?? keyName}</span>
      {numeric ? (
        <>
          <Input type="number" aria-label={b.from} className="w-28" value={range.gte ?? ""} onChange={(e) => onChange({ ...range, gte: e.target.value === "" ? undefined : Number(e.target.value) })} />
          <Input type="number" aria-label={b.to} className="w-28" value={range.lte ?? ""} onChange={(e) => onChange({ ...range, lte: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </>
      ) : typeof value === "boolean" || keyName.startsWith("is_") ? (
        <select aria-label={b.value} className={selectClass} value={String(value === true)} onChange={(e) => onChange(e.target.value === "true")}>
          <option value="true">{labels.common.yes}</option>
          <option value="false">{labels.common.no}</option>
        </select>
      ) : (
        <Input aria-label={b.value} className="w-56" value={typeof value === "string" || typeof value === "number" ? String(value) : ""} onChange={(e) => onChange(e.target.value)} />
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        {b.remove}
      </Button>
    </div>
  );
}
