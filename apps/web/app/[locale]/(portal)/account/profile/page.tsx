import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@beam/ui";
import { localeFromSegment, LOCALES, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { updateMyProfile } from "@/modules/crm/actions";
import { getMyProfile } from "@/modules/crm/queries";

type Search = { saved?: string; error?: string };

const text = (fd: FormData, key: string): string => {
  const value = fd.get(key);
  return typeof value === "string" ? value.trim() : "";
};

/**
 * `/[locale]/account/profile` (crm spec 5.2): the customer's own details. The email is read-only
 * ("contact us to change"); a stale `version` answers "Your details were changed elsewhere,
 * reload". A plain form POST to a server action, so it works without JavaScript.
 */
export default async function AccountProfilePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const sp = await searchParams;
  const tr = translator(locale);
  const profile = await getMyProfile(await getAppDb(), actor.personId);
  if (!profile) notFound();
  const here = `/${URL_SEGMENT[locale]}/account/profile`;

  async function save(fd: FormData) {
    "use server";
    const country = text(fd, "country").toUpperCase() || "BE";
    const address = { street: text(fd, "street"), number: text(fd, "number"), box: text(fd, "box"), postal_code: text(fd, "postal_code"), city: text(fd, "city"), country };
    const hasAddress = [address.street, address.number, address.box, address.postal_code, address.city].some(Boolean);
    const emergencyName = text(fd, "emergency_name");
    const emergencyPhone = text(fd, "emergency_phone");
    const relation = text(fd, "emergency_relation");
    const birthOn = text(fd, "birth_on");
    const channel = text(fd, "preferred_channel");
    const result = await updateMyProfile({
      version: Number(text(fd, "version")),
      firstName: text(fd, "first_name"),
      lastName: text(fd, "last_name"),
      phone: text(fd, "phone"),
      locale: text(fd, "locale") as Locale,
      ...(hasAddress ? { address: Object.fromEntries(Object.entries(address).filter(([, v]) => v !== "")) } : {}),
      ...(birthOn ? { birthOn } : {}),
      ...(channel ? { preferredChannel: channel } : {}),
      ...(emergencyName && emergencyPhone ? { emergencyContact: { name: emergencyName, phone: emergencyPhone, ...(relation ? { relation } : {}) } } : {}),
    });
    redirect(`${here}?${result.ok ? "saved=1" : `error=${result.error.code === "conflict" ? "conflict" : "invalid"}`}` as never);
  }

  const field = (name: string, label: string, value: string | null | undefined, opts: { type?: string; required?: boolean; autoComplete?: string } = {}) => (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <Input name={name} defaultValue={value ?? ""} type={opts.type ?? "text"} required={opts.required} autoComplete={opts.autoComplete} />
    </label>
  );
  const a = profile.address;
  const e = profile.emergencyContact;

  return (
    <section aria-labelledby="profile-title" className="grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <h1 id="profile-title" className="text-2xl font-semibold">
          {tr("crm.portal.profile.title")}
        </h1>
        <p className="text-sm">{tr("crm.portal.profile.intro")}</p>
      </header>
      <div aria-live="polite" role="status">
        {sp.saved ? (
          <Alert>
            <AlertDescription>{tr("crm.portal.profile.saved")}</AlertDescription>
          </Alert>
        ) : null}
        {sp.error ? (
          <Alert variant="destructive">
            <AlertDescription>{sp.error === "conflict" ? tr("crm.portal.profile.version_conflict") : tr("crm.portal.profile.error")}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <form action={save} className="grid gap-6">
        <input type="hidden" name="version" value={profile.version} />
        <Card>
          <CardHeader>
            <CardTitle>{tr("crm.portal.profile.title")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm">
              {tr("crm.portal.profile.customer_number")}: <span className="font-mono">{profile.customerNumber}</span>
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {field("first_name", tr("crm.portal.profile.first_name"), profile.firstName, { required: true, autoComplete: "given-name" })}
              {field("last_name", tr("crm.portal.profile.last_name"), profile.lastName, { required: true, autoComplete: "family-name" })}
            </div>
            <div className="grid gap-1 text-sm font-medium">
              <label htmlFor="profile-email">{tr("crm.portal.profile.email")}</label>
              <Input id="profile-email" value={profile.email ?? ""} readOnly aria-describedby="profile-email-help" />
              <p id="profile-email-help" className="text-sm font-normal">
                {tr("crm.portal.profile.email_readonly")}
              </p>
            </div>
            {field("phone", tr("crm.portal.profile.phone"), profile.phone, { type: "tel", autoComplete: "tel" })}
            {field("birth_on", tr("crm.portal.profile.birth_on"), profile.birthOn, { type: "date", autoComplete: "bday" })}
            <label className="grid gap-1 text-sm font-medium">
              {tr("crm.portal.profile.language")}
              <select name="locale" defaultValue={profile.locale} className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-4 focus-visible:ring-ring">
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {tr(`crm.enums.locale.${l.replace("-", "_")}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {tr("crm.portal.profile.preferred_channel")}
              <select name="preferred_channel" defaultValue={profile.preferredChannel ?? ""} className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-4 focus-visible:ring-ring">
                <option value="">{tr("crm.common.none")}</option>
                {(["email", "phone", "whatsapp"] as const).map((c) => (
                  <option key={c} value={c}>
                    {tr(`crm.enums.preferred_channel.${c}`)}
                  </option>
                ))}
              </select>
            </label>
          </CardContent>
        </Card>
        <fieldset className="grid gap-4 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-semibold">{tr("crm.portal.profile.address")}</legend>
          <div className="grid gap-4 sm:grid-cols-[1fr_6rem_6rem]">
            {field("street", tr("crm.portal.profile.street"), a?.street, { autoComplete: "address-line1" })}
            {field("number", tr("crm.portal.profile.number"), a?.number)}
            {field("box", tr("crm.portal.profile.box"), a?.box)}
          </div>
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr_6rem]">
            {field("postal_code", tr("crm.portal.profile.postal_code"), a?.postal_code, { autoComplete: "postal-code" })}
            {field("city", tr("crm.portal.profile.city"), a?.city, { autoComplete: "address-level2" })}
            {field("country", tr("crm.portal.profile.country"), a?.country ?? "BE", { autoComplete: "country" })}
          </div>
        </fieldset>
        <fieldset className="grid gap-4 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-semibold">{tr("crm.portal.profile.emergency_contact")}</legend>
          <p className="text-sm">{tr("crm.portal.profile.emergency_intro")}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            {field("emergency_name", tr("crm.portal.profile.emergency_name"), e?.name)}
            {field("emergency_phone", tr("crm.portal.profile.emergency_phone"), e?.phone, { type: "tel" })}
            {field("emergency_relation", tr("crm.portal.profile.emergency_relation"), e?.relation)}
          </div>
        </fieldset>
        <div>
          <Button type="submit">{tr("crm.portal.profile.save")}</Button>
        </div>
      </form>
    </section>
  );
}
