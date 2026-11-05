import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonVariants, EmptyState, Input } from "@beam/ui";
import { formatMoney } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, translator } from "@/lib/i18n";
import { getOpportunityFormOptions, getPipelineBoard } from "@/modules/crm/queries";
import { cardLabels, cardView, opportunityFormLabels, stageDialogLabels, stageNames } from "@/modules/crm/pipeline/queries";
import { OpportunityForm, PipelineBoard, type BoardLabels, type ColumnView } from "@/modules/crm/ui/pipeline/board";

/** `/admin/pipeline` (`crm.b2b`, flag `ff_crm_pipeline`), crm spec 5.1. */
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ owner?: string; min?: string; new?: string }> }) {
  const actor = await requireStaff({ permission: "crm.b2b" });
  if (!(await flag("ff_crm_pipeline", actor))) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const p = (k: string, params?: Record<string, string | number>) => tr(`crm.pipeline.${k}`, params);

  const options = await getOpportunityFormOptions(db);
  const owner = options.owners.some((o) => o.value === sp.owner) ? sp.owner : undefined;
  const minEuros = Number(sp.min);
  const minValueCents = Number.isFinite(minEuros) && minEuros > 0 ? Math.round(minEuros * 100) : undefined;
  const board = await getPipelineBoard(db, { ...(owner ? { ownerUserId: owner } : {}), ...(minValueCents ? { minValueCents } : {}) });
  const names = stageNames(tr);
  const columns: ColumnView[] = board.columns.map((c) => ({
    stage: c.stage,
    name: names[c.stage] ?? c.stage,
    total: formatMoney(c.totalCents, locale, { hideZeroDecimals: true }),
    weighted: formatMoney(c.weightedCents, locale, { hideZeroDecimals: true }),
    cards: c.cards.map((o) => cardView(o, locale)),
  }));
  const isEmpty = columns.every((c) => c.cards.length === 0) && board.won.count === 0 && board.lost.count === 0;
  const labels: BoardLabels = {
    card: cardLabels(tr),
    dialog: stageDialogLabels(tr),
    total: p("total"),
    weighted: p("weighted"),
    empty: p("column_empty"),
    dropWon: p("drop_won"),
    dropLost: p("drop_lost"),
  };
  const me = actor.kind === "staff" ? actor.userId : "";
  const defaultOwner = options.owners.some((o) => o.value === me) ? me : (options.owners[0]?.value ?? "");
  const showForm = sp.new === "1";

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{p("title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/pipeline/playbook" className={buttonVariants({ variant: "outline" })}>
            {p("playbook_link")}
          </Link>
          <Link href="/admin/pipeline?new=1" className={buttonVariants()}>
            {p("create")}
          </Link>
        </div>
      </header>
      {showForm ? (
        options.companies.length === 0 ? (
          <EmptyState
            title={p("no_companies")}
            action={
              <Link href="/admin/companies/new" className={buttonVariants()}>
                {tr("crm.companies.create")}
              </Link>
            }
          />
        ) : (
          <OpportunityForm
            initial={{ companyId: options.companies[0]!.value, title: "", primaryContactPersonId: "", value: "", probabilityPct: "", expectedCloseOn: "", ownerUserId: defaultOwner, nextAction: "", nextActionOn: "", source: "", notes: "" }}
            companies={options.companies}
            contacts={options.contacts}
            owners={options.owners}
            labels={opportunityFormLabels(tr)}
          />
        )
      ) : null}
      <form className="flex flex-wrap items-end gap-2" role="search">
        <select
          name="owner"
          defaultValue={owner ?? ""}
          aria-label={p("filter_owner")}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{p("all_owners")}</option>
          {options.owners.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Input name="min" type="number" min={0} defaultValue={sp.min ?? ""} aria-label={p("filter_min_value")} placeholder={p("filter_min_value")} className="max-w-48" />
        <Button type="submit" variant="outline">
          {p("filter")}
        </Button>
        {owner || minValueCents ? (
          <Link href="/admin/pipeline" className={buttonVariants({ variant: "ghost" })}>
            {tr("crm.common.clear_filters")}
          </Link>
        ) : null}
      </form>
      {isEmpty ? (
        <EmptyState title={p("empty")} />
      ) : (
        <>
          <PipelineBoard columns={columns} labels={labels} />
          <p className="text-sm text-muted-foreground">
            {p("won_summary", { count: board.won.count, value: formatMoney(board.won.valueCents, locale, { hideZeroDecimals: true }) })} · {p("lost_summary", { count: board.lost.count })}
          </p>
        </>
      )}
    </div>
  );
}

