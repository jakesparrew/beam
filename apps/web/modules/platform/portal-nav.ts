/**
 * The customer portal nav (platform spec 5): the generated `NAV.portal` entries in `order`,
 * without those whose optional `flag` is off for the customer (PL-43), as the admin layout does.
 */
export type PortalNavEntry = { key: string; href: string; labelKey: string; icon: string; order: number; flag?: string };

/** Entries whose flag is absent or on (a throwing flag check hides the entry), sorted by order then key. */
export async function visiblePortalEntries(
  entries: readonly PortalNavEntry[],
  isOn: (flag: string) => Promise<boolean>,
): Promise<PortalNavEntry[]> {
  const shown = await Promise.all(entries.map(async (e) => (!e.flag ? true : await isOn(e.flag).catch(() => false))));
  return entries.filter((_, i) => shown[i]).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}
