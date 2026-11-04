"use client";
/**
 * Navigation menu editor (site spec section 5 `/admin/site/navigation`, rule 24): one editable tree
 * per menu (header, footer, legal), labels in all three locales, a target picker per item, add,
 * reorder, remove and Save with the version check. Items hidden in a locale are marked. Saving
 * needs `site.publish`; without it the tree is read-only.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, EmptyState, Input } from "@beam/ui";
import { LOCALES } from "@beam/core/i18n";
import type { NavItem } from "@beam/core/site";
import { updateNavMenu } from "../../actions/nav";
import type { AdminNavMenu, EditorPickers, SiteAdminLabels } from "../../queries/admin";
import { LinkPicker, lbl } from "./pickers";

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()));
const blank = (): NavItem => ({ id: newId(), label: {}, target: { kind: "portal", route: "home" } });

function ItemFields({ item, onChange, onRemove, onMove, L, pickers, canEdit, hidden }: { item: NavItem; onChange: (i: NavItem) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; L: SiteAdminLabels; pickers: EditorPickers; canEdit: boolean; hidden: string[] }) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {LOCALES.map((l) => (
          <Input key={l} aria-label={`${lbl(L, "navigation.label")} ${l}`} placeholder={l} value={item.label[l] ?? ""} disabled={!canEdit} onChange={(e) => onChange({ ...item, label: { ...item.label, [l]: e.target.value } })} />
        ))}
      </div>
      <LinkPicker L={L} pickers={pickers} label={lbl(L, "navigation.target")} value={item.target} onChange={(target) => canEdit && onChange({ ...item, target })} />
      {hidden.length ? (
        <p className="text-xs text-destructive">
          {lbl(L, "issue.nav_target_hidden")} ({hidden.join(", ")})
        </p>
      ) : null}
      {canEdit ? (
        <div className="flex flex-wrap gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => onMove(-1)}>
            {lbl(L, "editor.moveUp")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onMove(1)}>
            {lbl(L, "editor.moveDown")}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={onRemove}>
            {lbl(L, "editor.delete")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const moved = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

function MenuTree({ menu, L, pickers, canEdit }: { menu: AdminNavMenu; L: SiteAdminLabels; pickers: EditorPickers; canEdit: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<NavItem[]>(menu.items);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const hiddenOf = (id: string) => menu.hidden.filter((h) => h.itemId === id).map((h) => h.locale);
  const save = () =>
    start(async () => {
      const res = await updateNavMenu({ key: menu.key, items, expectedVersion: menu.version });
      if (res.ok) {
        setStatus({ ok: true, text: lbl(L, "editor.saved") });
        router.refresh();
      } else setStatus({ ok: false, text: res.error.code === "conflict" ? lbl(L, "navigation.conflict") : res.error.fields ? Object.values(res.error.fields).join("; ") : res.error.message });
    });
  return (
    <section className="grid gap-3 rounded-md border p-4" aria-labelledby={`menu-${menu.key}`}>
      <div className="flex items-center justify-between">
        <h2 id={`menu-${menu.key}`} className="text-lg font-semibold">
          {lbl(L, `navigation.menu.${menu.key}`)}
        </h2>
        <Badge variant="outline">v{menu.version}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{lbl(L, "navigation.limits")}</p>
      {items.length === 0 ? <EmptyState title={lbl(L, "navigation.empty")} /> : null}
      <ol className="grid gap-3">
        {items.map((item, i) => (
          <li key={item.id} className="grid gap-2 rounded-md border p-3">
            <ItemFields
              item={item}
              L={L}
              pickers={pickers}
              canEdit={canEdit}
              hidden={hiddenOf(item.id)}
              onChange={(next) => setItems(items.map((x) => (x.id === item.id ? next : x)))}
              onRemove={() => setItems(items.filter((x) => x.id !== item.id))}
              onMove={(d) => setItems(moved(items, i, d))}
            />
            <ol className="ml-6 grid gap-2">
              {(item.children ?? []).map((child, j) => (
                <li key={child.id} className="rounded-md border p-2">
                  <ItemFields
                    item={child}
                    L={L}
                    pickers={pickers}
                    canEdit={canEdit}
                    hidden={hiddenOf(child.id)}
                    onChange={(next) => setItems(items.map((x) => (x.id === item.id ? { ...x, children: (x.children ?? []).map((c) => (c.id === child.id ? next : c)) } : x)))}
                    onRemove={() => setItems(items.map((x) => (x.id === item.id ? { ...x, children: (x.children ?? []).filter((c) => c.id !== child.id) } : x)))}
                    onMove={(d) => setItems(items.map((x) => (x.id === item.id ? { ...x, children: moved(x.children ?? [], j, d) } : x)))}
                  />
                </li>
              ))}
            </ol>
            {canEdit && (item.children?.length ?? 0) < 12 ? (
              <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setItems(items.map((x) => (x.id === item.id ? { ...x, children: [...(x.children ?? []), blank()] } : x)))}>
                {lbl(L, "navigation.addChild")}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          {items.length < 8 ? (
            <Button type="button" variant="outline" onClick={() => setItems([...items, blank()])}>
              {lbl(L, "navigation.add")}
            </Button>
          ) : null}
          <Button type="button" disabled={pending} onClick={save}>
            {lbl(L, "navigation.save")}
          </Button>
        </div>
      ) : null}
      {status ? (
        status.ok ? (
          <p role="status" className="text-sm text-success">
            {status.text}
          </p>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{status.text}</AlertDescription>
          </Alert>
        )
      ) : null}
    </section>
  );
}

export function NavEditor({ menus, L, pickers, canEdit }: { menus: AdminNavMenu[]; L: SiteAdminLabels; pickers: EditorPickers; canEdit: boolean }) {
  return (
    <div className="grid gap-6">
      {menus.map((m) => (
        <MenuTree key={`${m.key}:${m.version}`} menu={m} L={L} pickers={pickers} canEdit={canEdit} />
      ))}
    </div>
  );
}
