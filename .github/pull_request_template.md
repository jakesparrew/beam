## What and why

<!-- Title: `<module>: <imperative summary>`. Two to five lines on what changes for whom. -->

## Checklist

- [ ] Tests added or updated (Vitest beside the code; Playwright spec listed with `playwright test --list`)
- [ ] Every new user-visible text has keys in all three catalogues (`nl-BE`, `fr-BE`, `en`) and `pnpm i18n:check` is green
- [ ] Handbook page updated when a business rule changed
- [ ] User-visible change behind a feature flag (`ff_<module>_<name>`), or no flag needed because: ...
- [ ] No migration, `package.json` or frozen file edited outside the owner's package (`CONVENTIONS.md` item 3)
- [ ] No secrets, personal data or real email addresses (use `@example.com` and `@demo.beam.be`)

## Trailers

Package:
Requests:
Dependency-requests:
Missing-catalogue-keys:
