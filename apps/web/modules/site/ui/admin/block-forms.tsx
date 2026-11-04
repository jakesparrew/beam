"use client";
/**
 * Per-block forms of the page editor (site spec section 4 "Core types", section 5): one form per
 * block type with media, link, product, form and session pickers. `newBlock(type)` returns the
 * starting value of a new block; `BlockSchema` (core) validates it before the draft is saved.
 */
import { useId, type ReactNode } from "react";
import { Checkbox, Input, Label, Textarea } from "@beam/ui";
import { paragraphDoc, type Block, type BlockType, type Link, type RichDoc } from "@beam/core/site";
import type { EditorPickers, SiteAdminLabels } from "../../queries/admin";
import { LinkPicker, lbl, MediaPicker, OptionSelect, ProductMultiPicker, selectClass } from "./pickers";
import { RichTextEditor, type RichTextLabels } from "./rich-text-editor";

type Loose = Record<string, unknown> & { id: string; type: BlockType };

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** The starting value of a new block of `type`. */
export function newBlock(type: BlockType): Block {
  const id = uuid();
  const base: Record<BlockType, Record<string, unknown>> = {
    hero: { heading: "" },
    rich_text: { doc: paragraphDoc("") },
    image: { mediaId: "" },
    image_text: { mediaId: "", doc: paragraphDoc(""), imageSide: "left" },
    cta: { heading: "", button: { label: "", link: { kind: "portal", route: "home" } } },
    card_grid: { cards: [{ heading: "", text: "" }] },
    faq: { items: [{ question: "", answer: paragraphDoc("") }] },
    pricing_table: { productIds: [], showMemberPrice: true },
    events_list: { limit: 6, showFull: true },
    availability_preview: { kind: "day", days: 7 },
    posts_list: { limit: 6, paginate: true },
    form_embed: { formSlug: "" },
    booking_cta: { label: "", target: { kind: "book_day" } },
    video: { youtubeId: "", title: "", posterMediaId: "" },
    testimonial: { quote: "", authorName: "", consentConfirmed: false },
    contact_details: { showAddress: true, showPhone: true, showEmail: true, showOpeningHours: true },
    map: { mediaId: "", linkUrl: "https://" },
    legal_meta: {},
    webinar_signup: { webinarId: "" },
  };
  return { id, type, ...base[type] } as unknown as Block;
}

/** A copy of a block with new ids (duplicate, copy from another locale). */
export function cloneBlock(b: Block): Block {
  return { ...(JSON.parse(JSON.stringify(b)) as Block), id: uuid() };
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

function Text({ label, value, onChange, multiline, max }: { label: string; value: string | undefined; onChange: (v: string) => void; multiline?: boolean; max?: number }) {
  return (
    <Field label={label}>
      {(id) => (multiline ? <Textarea id={id} value={value ?? ""} maxLength={max} onChange={(e) => onChange(e.target.value)} /> : <Input id={id} value={value ?? ""} maxLength={max} onChange={(e) => onChange(e.target.value)} />)}
    </Field>
  );
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return <Field label={label}>{(id) => <Input id={id} type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />}</Field>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

export type BlockFormProps = { block: Block; onChange: (b: Block) => void; L: SiteAdminLabels; pickers: EditorPickers; rich: RichTextLabels };

export function BlockForm({ block, onChange, L, pickers, rich }: BlockFormProps) {
  const b = block as unknown as Loose;
  const t = (field: string) => lbl(L, `block.${b.type}.${field}`);
  const set = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...b, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    onChange(next as unknown as Block);
  };
  const str = (k: string) => (b[k] as string | undefined) ?? "";
  const optStr = (k: string) => (v: string) => set({ [k]: v === "" ? undefined : v });
  const doc = (k: string) => (b[k] as RichDoc | undefined) ?? paragraphDoc("");
  const button = (k: string, required: boolean) => {
    const value = b[k] as { label: string; link: Link } | undefined;
    return (
      <fieldset className="grid gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t(k)}</legend>
        {!required ? <Toggle label={t(k)} checked={!!value} onChange={(on) => set({ [k]: on ? { label: "", link: { kind: "portal", route: "home" } } : undefined })} /> : null}
        {value ? (
          <>
            <Text label={lbl(L, "block.booking_cta.label")} value={value.label} max={60} onChange={(v) => set({ [k]: { ...value, label: v } })} />
            <LinkPicker L={L} pickers={pickers} label={lbl(L, "navigation.target")} value={value.link} onChange={(link) => set({ [k]: { ...value, link } })} />
          </>
        ) : null}
      </fieldset>
    );
  };

  switch (b.type) {
    case "hero":
      return (
        <div className="grid gap-3">
          <Text label={t("heading")} value={str("heading")} max={120} onChange={(v) => set({ heading: v })} />
          <Text label={t("subheading")} value={str("subheading")} max={300} onChange={optStr("subheading")} />
          <MediaPicker L={L} pickers={pickers} label={t("mediaId")} value={b.mediaId as string | undefined} onChange={(v) => set({ mediaId: v })} />
          {button("cta", false)}
        </div>
      );
    case "rich_text":
      return <RichTextEditor ariaLabel={t("doc")} labels={rich} value={doc("doc")} onChange={(d) => set({ doc: d })} />;
    case "image":
      return (
        <div className="grid gap-3">
          <MediaPicker L={L} pickers={pickers} label={t("mediaId")} value={str("mediaId") || undefined} onChange={(v) => set({ mediaId: v ?? "" })} />
          <Text label={t("caption")} value={str("caption")} max={300} onChange={optStr("caption")} />
        </div>
      );
    case "image_text":
      return (
        <div className="grid gap-3">
          <MediaPicker L={L} pickers={pickers} label={t("mediaId")} value={str("mediaId") || undefined} onChange={(v) => set({ mediaId: v ?? "" })} />
          <Field label={t("imageSide")}>
            {(id) => (
              <select id={id} className={selectClass} value={str("imageSide")} onChange={(e) => set({ imageSide: e.target.value })}>
                <option value="left">{lbl(L, "block.side.left")}</option>
                <option value="right">{lbl(L, "block.side.right")}</option>
              </select>
            )}
          </Field>
          <RichTextEditor ariaLabel={t("doc")} labels={rich} value={doc("doc")} onChange={(d) => set({ doc: d })} />
        </div>
      );
    case "cta":
      return (
        <div className="grid gap-3">
          <Text label={t("heading")} value={str("heading")} max={120} onChange={(v) => set({ heading: v })} />
          <Text label={t("text")} value={str("text")} max={500} multiline onChange={optStr("text")} />
          {button("button", true)}
        </div>
      );
    case "card_grid": {
      const cards = (b.cards as { heading: string; text: string; mediaId?: string; link?: Link }[]) ?? [];
      const setCard = (i: number, patch: Record<string, unknown>) => set({ cards: cards.map((c, j) => (j === i ? Object.fromEntries(Object.entries({ ...c, ...patch }).filter(([, v]) => v !== undefined)) : c)) });
      return (
        <div className="grid gap-3">
          <Text label={t("heading")} value={str("heading")} max={120} onChange={optStr("heading")} />
          {cards.map((c, i) => (
            <fieldset key={i} className="grid gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">
                {t("cards")} {i + 1}
              </legend>
              <Text label={lbl(L, "block.cta.heading")} value={c.heading} max={120} onChange={(v) => setCard(i, { heading: v })} />
              <Text label={lbl(L, "block.cta.text")} value={c.text} max={500} multiline onChange={(v) => setCard(i, { text: v })} />
              <MediaPicker L={L} pickers={pickers} label={lbl(L, "block.image.mediaId")} value={c.mediaId} onChange={(v) => setCard(i, { mediaId: v })} />
              <Toggle label={lbl(L, "navigation.target")} checked={!!c.link} onChange={(on) => setCard(i, { link: on ? { kind: "portal", route: "home" } : undefined })} />
              {c.link ? <LinkPicker L={L} pickers={pickers} label={lbl(L, "navigation.target")} value={c.link} onChange={(link) => setCard(i, { link })} /> : null}
              <button type="button" className="justify-self-start text-sm text-destructive underline" onClick={() => set({ cards: cards.filter((_, j) => j !== i) })} disabled={cards.length <= 1}>
                {lbl(L, "editor.delete")}
              </button>
            </fieldset>
          ))}
          {cards.length < 12 ? (
            <button type="button" className="justify-self-start text-sm underline" onClick={() => set({ cards: [...cards, { heading: "", text: "" }] })}>
              {lbl(L, "editor.addBlock")}
            </button>
          ) : null}
        </div>
      );
    }
    case "faq": {
      const items = (b.items as { question: string; answer: RichDoc }[]) ?? [];
      const setItem = (i: number, patch: Record<string, unknown>) => set({ items: items.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
      return (
        <div className="grid gap-3">
          <Text label={t("heading")} value={str("heading")} max={120} onChange={optStr("heading")} />
          {items.map((it, i) => (
            <fieldset key={i} className="grid gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">
                {t("items")} {i + 1}
              </legend>
              <Text label={t("items")} value={it.question} max={300} onChange={(v) => setItem(i, { question: v })} />
              <RichTextEditor ariaLabel={lbl(L, "block.rich_text.doc")} labels={rich} value={it.answer} onChange={(d) => setItem(i, { answer: d })} />
              <button type="button" className="justify-self-start text-sm text-destructive underline" onClick={() => set({ items: items.filter((_, j) => j !== i) })} disabled={items.length <= 1}>
                {lbl(L, "editor.delete")}
              </button>
            </fieldset>
          ))}
          {items.length < 30 ? (
            <button type="button" className="justify-self-start text-sm underline" onClick={() => set({ items: [...items, { question: "", answer: paragraphDoc("") }] })}>
              {lbl(L, "editor.addBlock")}
            </button>
          ) : null}
        </div>
      );
    }
    case "pricing_table":
      return (
        <div className="grid gap-3">
          <Text label={t("heading")} value={str("heading")} max={120} onChange={optStr("heading")} />
          <ProductMultiPicker label={t("productIds")} pickers={pickers} value={(b.productIds as string[]) ?? []} onChange={(v) => set({ productIds: v })} />
          <Toggle label={t("showMemberPrice")} checked={!!b.showMemberPrice} onChange={(v) => set({ showMemberPrice: v })} />
        </div>
      );
    case "events_list":
    case "posts_list":
      return (
        <div className="grid gap-3">
          <Text label={t("heading")} value={str("heading")} max={120} onChange={optStr("heading")} />
          <NumberField label={t("limit")} value={Number(b.limit ?? 6)} min={1} max={24} onChange={(v) => set({ limit: v })} />
          {b.type === "events_list" ? <Toggle label={t("showFull")} checked={!!b.showFull} onChange={(v) => set({ showFull: v })} /> : <Toggle label={t("paginate")} checked={!!b.paginate} onChange={(v) => set({ paginate: v })} />}
        </div>
      );
    case "availability_preview":
      return (
        <div className="grid gap-3">
          <Field label={t("kind")}>
            {(id) => (
              <select id={id} className={selectClass} value={str("kind")} onChange={(e) => set({ kind: e.target.value })}>
                <option value="day">{lbl(L, "block.target.book_day")}</option>
                <option value="night">{lbl(L, "block.target.book_night")}</option>
              </select>
            )}
          </Field>
          <NumberField label={t("days")} value={Number(b.days ?? 7)} min={1} max={14} onChange={(v) => set({ days: v })} />
        </div>
      );
    case "form_embed":
      return <OptionSelect label={t("formSlug")} value={str("formSlug")} onChange={(v) => set({ formSlug: v })} options={pickers.forms.map((f) => ({ id: f.slug, label: f.label, hint: f.locales.join(", ") }))} />;
    case "booking_cta": {
      const target = (b.target as { kind: string; sessionId?: string; productId?: string }) ?? { kind: "book_day" };
      return (
        <div className="grid gap-3">
          <Text label={t("label")} value={str("label")} max={60} onChange={(v) => set({ label: v })} />
          <Field label={t("target")}>
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={target.kind}
                onChange={(e) => {
                  const kind = e.target.value;
                  set({ target: kind === "session" ? { kind, sessionId: pickers.sessions[0]?.id ?? "" } : kind === "buy_product" ? { kind, productId: pickers.products[0]?.id ?? "" } : { kind } });
                }}
              >
                {(["book_day", "book_night", "session", "buy_product", "gift"] as const).map((k) => (
                  <option key={k} value={k}>
                    {lbl(L, `block.target.${k}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {target.kind === "session" ? <OptionSelect label={lbl(L, "block.target.session")} value={target.sessionId ?? ""} onChange={(v) => set({ target: { kind: "session", sessionId: v } })} options={pickers.sessions} /> : null}
          {target.kind === "buy_product" ? <OptionSelect label={lbl(L, "block.target.buy_product")} value={target.productId ?? ""} onChange={(v) => set({ target: { kind: "buy_product", productId: v } })} options={pickers.products} /> : null}
        </div>
      );
    }
    case "video":
      return (
        <div className="grid gap-3">
          <Text label={t("youtubeId")} value={str("youtubeId")} max={11} onChange={(v) => set({ youtubeId: v })} />
          <Text label={t("title")} value={str("title")} max={200} onChange={(v) => set({ title: v })} />
          <MediaPicker L={L} pickers={pickers} label={t("posterMediaId")} value={str("posterMediaId") || undefined} onChange={(v) => set({ posterMediaId: v ?? "" })} />
        </div>
      );
    case "testimonial":
      return (
        <div className="grid gap-3">
          <Text label={t("quote")} value={str("quote")} max={1000} multiline onChange={(v) => set({ quote: v })} />
          <Text label={t("authorName")} value={str("authorName")} max={120} onChange={(v) => set({ authorName: v })} />
          <Text label={t("authorDetail")} value={str("authorDetail")} max={120} onChange={optStr("authorDetail")} />
          <Toggle label={t("consentConfirmed")} checked={b.consentConfirmed === true} onChange={(v) => set({ consentConfirmed: v })} />
        </div>
      );
    case "contact_details":
      return (
        <div className="grid gap-2">
          {(["showAddress", "showPhone", "showEmail", "showOpeningHours"] as const).map((k) => (
            <Toggle key={k} label={t(k)} checked={!!b[k]} onChange={(v) => set({ [k]: v })} />
          ))}
        </div>
      );
    case "map":
      return (
        <div className="grid gap-3">
          <MediaPicker L={L} pickers={pickers} label={t("mediaId")} value={str("mediaId") || undefined} onChange={(v) => set({ mediaId: v ?? "" })} />
          <Text label={t("linkUrl")} value={str("linkUrl")} max={500} onChange={(v) => set({ linkUrl: v })} />
        </div>
      );
    case "webinar_signup":
      return <Text label={t("webinarId")} value={str("webinarId")} onChange={(v) => set({ webinarId: v })} />;
    case "legal_meta":
    default:
      return null;
  }
}
