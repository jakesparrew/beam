/**
 * Company identification in every public footer (rule 60, Belgian Code of Economic Law book
 * XII): legal name, registered address, enterprise number (`BE 0123.456.789`), VAT number,
 * support email and phone, from `settings.company`.
 */
import type { CompanyFooter as CompanyFooterData } from "@beam/core/site";
import type { Tr } from "./block-renderer";

export function CompanyFooter({ company, tr }: { company: CompanyFooterData; tr: Tr }) {
  return (
    <address className="space-y-1 text-sm not-italic text-muted-foreground" data-company>
      {company.legalName ? <p className="font-semibold text-foreground">{company.legalName}</p> : null}
      {company.addressLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {company.enterpriseNumber ? <p>{tr("site.public.footer.enterpriseNumber", { number: company.enterpriseNumber })}</p> : null}
      {company.vatNumber ? <p>{tr("site.public.footer.vat", { number: company.vatNumber })}</p> : null}
      {company.email ? (
        <p>
          <a href={`mailto:${company.email}`} className="hover:underline">
            {company.email}
          </a>
        </p>
      ) : null}
      {company.phone ? (
        <p>
          <a href={`tel:${company.phone.replace(/[^+0-9]/g, "")}`} className="hover:underline">
            {company.phone}
          </a>
        </p>
      ) : null}
    </address>
  );
}
