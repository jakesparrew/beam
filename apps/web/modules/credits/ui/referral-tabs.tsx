"use client";
/**
 * `/admin/referrals` (credits spec section 5, rules 60 to 63, R3): four tabs. Codes (owner, uses,
 * rewards, active; new partner code, activate or deactivate), Attributions (status, referrer or
 * partner, first paid, reward; attribute a person, reject a pending one), Commissions (month,
 * partner, order, amount, status; approve, mark paid or void the selected rows) and Partners
 * (`v_partner_performance` per company). Writes need `referrals.manage` (`canManage`); readers with
 * `reports.read` only see. The page formats every date and amount; every string is a prop.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, FormField, Input, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from "@beam/ui";
import { attributeReferral, createReferralCode, findReferralPersons, rejectAttribution, setCommissionStatus, updateReferralCode } from "../actions";
import { ActionDialog, errorMessage, str, type ActionResultLike, type Labels } from "./adjust-dialog";
import { PartnerFigures, type PartnerFigureRow } from "./partner-figures";

export type CodeView = { id: string; code: string; ownerText: string; ownerPersonId: string | null; usesText: string; rewardsText: string; isActive: boolean };
export type AttributionView = {
  id: string;
  status: "pending" | "qualified" | "rewarded" | "rejected";
  referredName: string;
  referredPersonId: string;
  referrerText: string;
  sourceText: string;
  attributedText: string;
  firstPaidText: string;
  qualifiesText: string;
  rewardText: string;
};
export type CommissionView = { id: string; status: "accrued" | "approved" | "paid" | "void"; monthText: string; partnerText: string; orderText: string; orderId: string; baseText: string; pctText: string; amountText: string };
export type PartnerOption = { id: string; name: string };

const SPECIFIC = ["code_taken", "code_exists", "not_a_partner", "already_attributed", "attribution_not_pending", "referrer_required"];
const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Maps the referral-specific messages onto `errors.<message>` for `errorMessage`. */
function specific(r: ActionResultLike): ActionResultLike {
  if (r.ok) return r;
  const hit = SPECIFIC.find((k) => r.error.message === k || r.error.message.startsWith(`${k}:`) || Object.values(r.error.fields ?? {}).includes(k));
  return hit ? { ok: false, error: { ...r.error, code: hit, message: hit } } : r;
}

function reward(form: FormData, prefix: string) {
  const units = str(form, `${prefix}_units`, "").trim();
  if (!units) return undefined;
  return { credit_kind: str(form, `${prefix}_kind`, "day") as "day" | "night", units: Number(units), validity_days: Number(str(form, `${prefix}_validity`, "180") || 180) };
}

function RewardFields({ prefix, legend, labels: l }: { prefix: string; legend: string; labels: Labels }) {
  const r = (k: string) => l[`admin.referrals.${k}`] ?? "";
  return (
    <fieldset className="grid gap-2 sm:grid-cols-3">
      <legend className="text-sm font-medium sm:col-span-3">{legend}</legend>
      <FormField label={r("reward_units")} hint={r("reward_default")}>
        <Input name={`${prefix}_units`} type="number" min={1} max={20} />
      </FormField>
      <FormField label={r("reward_kind")}>
        <select name={`${prefix}_kind`} defaultValue="day" className={selectClass}>
          <option value="day">{l["enum.kind.day"]}</option>
          <option value="night">{l["enum.kind.night"]}</option>
        </select>
      </FormField>
      <FormField label={r("reward_validity_days")}>
        <Input name={`${prefix}_validity`} type="number" min={1} max={1825} defaultValue={180} />
      </FormField>
    </fieldset>
  );
}

/** A small person search for the attribution form (`findReferralPersons`). */
function PersonSearch({ name, label, labels: l }: { name: string; label: string; labels: Labels }) {
  const r = (k: string) => l[`admin.referrals.${k}`] ?? "";
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; email: string | null }[] | null>(null);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  if (picked) {
    return (
      <div className="grid gap-1">
        <input type="hidden" name={name} value={picked.id} />
        <p className="text-sm font-medium">{label}</p>
        <div className="flex items-center gap-2 text-sm">
          {picked.name}
          <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(null)}>
            {r("change")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <FormField label={label}>
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={r("search_hint")} />
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              if (q.trim().length < 2) return;
              const res = await findReferralPersons({ q });
              setResults(res.ok ? res.data : []);
            }}
          >
            {r("search")}
          </Button>
        </div>
      </FormField>
      {results ? (
        results.length ? (
          <ul className="grid gap-1">
            {results.map((p) => (
              <li key={p.id}>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPicked({ id: p.id, name: p.email ? `${p.name} (${p.email})` : p.name })}>
                  {p.email ? `${p.name} (${p.email})` : p.name}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{r("no_results")}</p>
        )
      ) : null}
    </div>
  );
}

function CodesTab({ codes, partners, canManage, labels: l }: { codes: CodeView[]; partners: PartnerOption[]; canManage: boolean; labels: Labels }) {
  const r = (k: string) => l[`admin.referrals.${k}`] ?? "";
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      {canManage ? (
        <div>
          <ActionDialog
            trigger={r("new_code")}
            title={r("new_code_title")}
            submitLabel={r("create")}
            labels={l}
            onSubmit={async (f) =>
              specific(
                await createReferralCode({
                  partnerCompanyId: str(f, "partnerCompanyId", ""),
                  code: str(f, "code", ""),
                  maxUses: str(f, "maxUses", "") === "" ? null : Number(str(f, "maxUses", "")),
                  referrerReward: reward(f, "referrer") ?? null,
                  refereeReward: reward(f, "referee") ?? null,
                }),
              )
            }
          >
            {(fields) => (
              <>
                <FormField label={r("partner")} error={fields.partnerCompanyId ?? null} required>
                  <select name="partnerCompanyId" required className={selectClass} defaultValue="">
                    <option value="" disabled>
                      {r("partner_pick")}
                    </option>
                    {partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label={r("code_optional")} hint={r("code_hint")} error={fields.code ?? null}>
                  <Input name="code" maxLength={12} autoCapitalize="characters" />
                </FormField>
                <FormField label={r("max_uses")} error={fields.maxUses ?? null}>
                  <Input name="maxUses" type="number" min={1} />
                </FormField>
                <RewardFields prefix="referrer" legend={r("referrer_reward")} labels={l} />
                <RewardFields prefix="referee" legend={r("referee_reward")} labels={l} />
              </>
            )}
          </ActionDialog>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {codes.length === 0 ? (
        <p className="text-muted-foreground">{r("empty")}</p>
      ) : (
        <Table>
          <TableCaption>{r("codes_caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{r("col_code")}</TableHead>
              <TableHead scope="col">{r("col_owner")}</TableHead>
              <TableHead scope="col">{r("col_uses")}</TableHead>
              <TableHead scope="col">{r("col_rewards")}</TableHead>
              <TableHead scope="col">{r("col_status")}</TableHead>
              {canManage ? <TableHead scope="col">{r("col_actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {codes.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono">{c.code}</TableCell>
                <TableCell>
                  {c.ownerPersonId ? (
                    <Link href={`/admin/persons/${c.ownerPersonId}`} className="underline">
                      {c.ownerText}
                    </Link>
                  ) : (
                    c.ownerText
                  )}
                </TableCell>
                <TableCell>{c.usesText}</TableCell>
                <TableCell>{c.rewardsText}</TableCell>
                <TableCell>
                  <Badge variant={c.isActive ? "default" : "secondary"}>{c.isActive ? r("active") : r("inactive")}</Badge>
                </TableCell>
                {canManage ? (
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        setError(null);
                        const res = specific(await updateReferralCode({ codeId: c.id, isActive: !c.isActive }));
                        if (res.ok) router.refresh();
                        else setError(errorMessage(res.error, l));
                      }}
                    >
                      {c.isActive ? r("deactivate") : r("activate")}
                    </Button>
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

function AttributionsTab({ rows, canManage, labels: l }: { rows: AttributionView[]; canManage: boolean; labels: Labels }) {
  const r = (k: string) => l[`admin.referrals.${k}`] ?? "";
  return (
    <div className="grid gap-4">
      {canManage ? (
        <div>
          <ActionDialog
            trigger={r("attribute")}
            title={r("attribute_title")}
            submitLabel={r("attribute_submit")}
            labels={l}
            onSubmit={async (f) =>
              specific(await attributeReferral({ referredPersonId: str(f, "referredPersonId", ""), referrerPersonId: str(f, "referrerPersonId", "") }))
            }
          >
            {() => (
              <>
                <PersonSearch name="referredPersonId" label={r("referred_person")} labels={l} />
                <PersonSearch name="referrerPersonId" label={r("referrer_person")} labels={l} />
              </>
            )}
          </ActionDialog>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{r("empty")}</p>
      ) : (
        <Table>
          <TableCaption>{r("attributions_caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{r("col_referred")}</TableHead>
              <TableHead scope="col">{r("col_referrer")}</TableHead>
              <TableHead scope="col">{r("col_source")}</TableHead>
              <TableHead scope="col">{r("col_status")}</TableHead>
              <TableHead scope="col">{r("col_attributed")}</TableHead>
              <TableHead scope="col">{r("col_first_paid")}</TableHead>
              <TableHead scope="col">{r("col_reward")}</TableHead>
              {canManage ? <TableHead scope="col">{r("col_actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link href={`/admin/persons/${a.referredPersonId}`} className="underline">
                    {a.referredName}
                  </Link>
                </TableCell>
                <TableCell>{a.referrerText}</TableCell>
                <TableCell>{a.sourceText}</TableCell>
                <TableCell>
                  <Badge variant={a.status === "rejected" ? "secondary" : "default"}>{l[`enum.attribution_status.${a.status}`] ?? a.status}</Badge>
                </TableCell>
                <TableCell>{a.attributedText}</TableCell>
                <TableCell>{a.firstPaidText}</TableCell>
                <TableCell>{a.rewardText}</TableCell>
                {canManage ? (
                  <TableCell>
                    {a.status === "pending" ? (
                      <ActionDialog
                        trigger={r("reject")}
                        title={r("reject_title")}
                        submitLabel={r("reject_submit")}
                        destructive
                        labels={l}
                        onSubmit={async (f) => specific(await rejectAttribution({ attributionId: a.id, reason: str(f, "reason", "") }))}
                      >
                        {(fields) => (
                          <FormField label={l["admin.common.reason"] ?? ""} hint={l["admin.common.reason_hint"]} error={fields.reason ?? null} required>
                            <Textarea name="reason" minLength={3} maxLength={500} rows={2} required />
                          </FormField>
                        )}
                      </ActionDialog>
                    ) : null}
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

function CommissionsTab({ rows, canManage, labels: l }: { rows: CommissionView[]; canManage: boolean; labels: Labels }) {
  const r = (k: string) => l[`admin.referrals.${k}`] ?? "";
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function apply(status: "approved" | "paid" | "void") {
    setBusy(true);
    setError(null);
    try {
      const res = await setCommissionStatus({ commissionIds: [...selected], status });
      if (res.ok) {
        setSelected(new Set());
        router.refresh();
      } else setError(errorMessage(res.error, l));
    } finally {
      setBusy(false);
    }
  }
  if (rows.length === 0) return <p className="text-muted-foreground">{r("empty")}</p>;
  return (
    <div className="grid gap-4">
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {(r("selected_count") || "{count}").replace("{count}", String(selected.size))}
          </span>
          <Button type="button" variant="outline" disabled={busy || !selected.size} onClick={() => void apply("approved")}>
            {r("approve")}
          </Button>
          <Button type="button" variant="outline" disabled={busy || !selected.size} onClick={() => void apply("paid")}>
            {r("mark_paid")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !selected.size} onClick={() => void apply("void")}>
            {r("void")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Table>
        <TableCaption>{r("commissions_caption")}</TableCaption>
        <TableHeader>
          <TableRow>
            {canManage ? <TableHead scope="col">{r("select")}</TableHead> : null}
            <TableHead scope="col">{r("col_month")}</TableHead>
            <TableHead scope="col">{r("col_partner")}</TableHead>
            <TableHead scope="col">{r("col_order")}</TableHead>
            <TableHead scope="col" className="text-right">{r("col_base")}</TableHead>
            <TableHead scope="col" className="text-right">{r("col_pct")}</TableHead>
            <TableHead scope="col" className="text-right">{r("col_amount")}</TableHead>
            <TableHead scope="col">{r("col_status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id}>
              {canManage ? (
                <TableCell>
                  {c.status === "accrued" || c.status === "approved" ? (
                    <input
                      type="checkbox"
                      className="size-5"
                      aria-label={`${r("select")} ${c.orderText}`}
                      checked={selected.has(c.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setSelected(next);
                      }}
                    />
                  ) : null}
                </TableCell>
              ) : null}
              <TableCell>{c.monthText}</TableCell>
              <TableCell>{c.partnerText}</TableCell>
              <TableCell>{c.orderText}</TableCell>
              <TableCell className="text-right tabular-nums">{c.baseText}</TableCell>
              <TableCell className="text-right tabular-nums">{c.pctText}</TableCell>
              <TableCell className="text-right tabular-nums">{c.amountText}</TableCell>
              <TableCell>
                <Badge variant={c.status === "void" ? "secondary" : "default"}>{l[`enum.commission_status.${c.status}`] ?? c.status}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ReferralTabs(props: {
  codes: CodeView[];
  attributions: AttributionView[];
  commissions: CommissionView[];
  partners: PartnerFigureRow[];
  partnerOptions: PartnerOption[];
  canManage: boolean;
  labels: Labels;
}) {
  const l = props.labels;
  const r = (k: string) => l[`admin.referrals.${k}`] ?? "";
  return (
    <Tabs defaultValue="codes" className="grid gap-4">
      <TabsList>
        <TabsTrigger value="codes">{r("tab_codes")}</TabsTrigger>
        <TabsTrigger value="attributions">{r("tab_attributions")}</TabsTrigger>
        <TabsTrigger value="commissions">{r("tab_commissions")}</TabsTrigger>
        <TabsTrigger value="partners">{r("tab_partners")}</TabsTrigger>
      </TabsList>
      <TabsContent value="codes">
        <CodesTab codes={props.codes} partners={props.partnerOptions} canManage={props.canManage} labels={l} />
      </TabsContent>
      <TabsContent value="attributions">
        <AttributionsTab rows={props.attributions} canManage={props.canManage} labels={l} />
      </TabsContent>
      <TabsContent value="commissions">
        <CommissionsTab rows={props.commissions} canManage={props.canManage} labels={l} />
      </TabsContent>
      <TabsContent value="partners">
        <PartnerFigures
          rows={props.partners}
          labels={{
            caption: r("partners_caption"),
            firstColumn: r("col_partner"),
            referred: r("col_referred_count"),
            customers: r("col_customers"),
            revenue: r("col_revenue"),
            accrued: r("col_accrued"),
            paid: r("col_paid"),
            total: r("total"),
            empty: r("empty"),
          }}
        />
      </TabsContent>
    </Tabs>
  );
}
